#import "BitnetDownloader.h"
#import "BitnetCache.h"
#import <CommonCrypto/CommonDigest.h>

static NSString *const kSessionIdentifier = @"com.bitnet.downloads";

// Tracks one in-flight download. Multiple JS callers wanting the same
// cacheKey share a single RunningDownload — their promises are queued.
@interface BitnetRunningDownload : NSObject
@property (nonatomic, copy) NSString *cacheKey;
@property (nonatomic, copy) NSString *modelRef;
@property (nonatomic, copy) NSString *url;
@property (nonatomic, copy) NSString *expectedSha256;
@property (nonatomic, assign) int64_t expectedSizeBytes;
@property (nonatomic, strong) NSURLSessionDownloadTask *task;
@property (nonatomic, strong) NSMutableArray *resolvers; // void (^)(NSDictionary *)
@property (nonatomic, strong) NSMutableArray *rejecters; // void (^)(NSString*, NSString*)
@property (nonatomic, assign) BOOL cancelled;
@property (nonatomic, assign) BOOL deletePending;
@property (nonatomic, assign) int64_t lastEmitBytes;
@property (nonatomic, assign) NSTimeInterval lastEmitTime;
@end
@implementation BitnetRunningDownload @end


@interface BitnetDownloader () <NSURLSessionDownloadDelegate>
@property (nonatomic, strong) NSURLSession *session;
@property (nonatomic, strong) NSMutableDictionary<NSString *, BitnetRunningDownload *> *running;
@property (nonatomic, strong) dispatch_queue_t lockQueue;
@end


// Stored AppDelegate completion handlers, keyed by session identifier.
static NSMutableDictionary<NSString *, void (^)(void)> *sCompletionHandlers;
static dispatch_once_t sCompletionHandlersOnce;


@implementation BitnetDownloader

+ (instancetype)sharedInstance {
  static BitnetDownloader *shared;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ shared = [[BitnetDownloader alloc] init]; });
  return shared;
}

- (instancetype)init {
  if ((self = [super init])) {
    _running = [NSMutableDictionary dictionary];
    _lockQueue = dispatch_queue_create("com.bitnet.downloader.lock", DISPATCH_QUEUE_SERIAL);
    NSURLSessionConfiguration *config =
      [NSURLSessionConfiguration backgroundSessionConfigurationWithIdentifier:kSessionIdentifier];
    config.HTTPMaximumConnectionsPerHost = 4;
    config.discretionary = NO;
    config.sessionSendsLaunchEvents = YES;
    _session = [NSURLSession sessionWithConfiguration:config delegate:self delegateQueue:nil];
  }
  return self;
}

+ (void)storeCompletionHandler:(void (^)(void))completionHandler
                 forIdentifier:(NSString *)identifier {
  dispatch_once(&sCompletionHandlersOnce, ^{
    sCompletionHandlers = [NSMutableDictionary dictionary];
  });
  if (completionHandler) {
    sCompletionHandlers[identifier] = completionHandler;
  }
}

- (BOOL)isRunning:(NSString *)cacheKey {
  __block BOOL result = NO;
  dispatch_sync(_lockQueue, ^{
    result = self.running[cacheKey] != nil;
  });
  return result;
}

- (BOOL)hasActiveDownloads {
  __block BOOL result = NO;
  dispatch_sync(_lockQueue, ^{
    result = self.running.count > 0;
  });
  return result;
}

- (void)startWithCacheKey:(NSString *)cacheKey
                 modelRef:(NSString *)modelRef
                      url:(NSString *)url
               authHeader:(NSString *)authHeader
        expectedSizeBytes:(int64_t)expectedSizeBytes
           expectedSha256:(NSString *)expectedSha256
                  resolve:(void (^)(NSDictionary *))resolve
                   reject:(void (^)(NSString *, NSString *))reject {

  dispatch_async(_lockQueue, ^{
    BitnetRunningDownload *existing = self.running[cacheKey];
    if (existing) {
      [existing.resolvers addObject:[resolve copy]];
      [existing.rejecters addObject:[reject copy]];
      return;
    }

    // Short-circuit: already complete on disk.
    BitnetCacheMeta *meta = [BitnetCache readMetaForCacheKey:cacheKey];
    NSString *finalPath = [BitnetCache finalFileForCacheKey:cacheKey];
    if (meta.complete && [[NSFileManager defaultManager] fileExistsAtPath:finalPath]) {
      NSDictionary *result = @{
        @"localPath": finalPath,
        @"sizeBytes": @([[NSFileManager defaultManager] attributesOfItemAtPath:finalPath error:nil].fileSize),
        @"sha256": meta.actualSha256 ?: @"",
        @"resumed": @NO,
      };
      resolve(result);
      return;
    }

    BitnetRunningDownload *r = [BitnetRunningDownload new];
    r.cacheKey = cacheKey;
    r.modelRef = modelRef;
    r.url = url;
    r.expectedSha256 = expectedSha256 ?: @"";
    r.expectedSizeBytes = expectedSizeBytes;
    r.resolvers = [@[[resolve copy]] mutableCopy];
    r.rejecters = [@[[reject copy]] mutableCopy];
    r.lastEmitTime = [NSDate date].timeIntervalSince1970;
    self.running[cacheKey] = r;

    long long now = (long long)([NSDate date].timeIntervalSince1970 * 1000);

    // Persist start-of-download meta (complete:false, lastError:"").
    BitnetCacheMeta *startMeta = meta ?: [BitnetCacheMeta new];
    if (!meta) {
      startMeta.modelRef = modelRef;
      startMeta.resolvedUrl = url;
      startMeta.createdAt = now;
    }
    startMeta.expectedSizeBytes = expectedSizeBytes;
    startMeta.expectedSha256 = expectedSha256 ?: @"";
    startMeta.complete = NO;
    startMeta.lastError = @"";
    [BitnetCache writeMeta:startMeta forCacheKey:cacheKey];

    // Try to resume from saved resume data.
    NSString *resumePath = [BitnetCache resumeFileForCacheKey:cacheKey];
    NSData *resumeData = [NSData dataWithContentsOfFile:resumePath];

    NSURLSessionDownloadTask *task;
    if (resumeData) {
      task = [self.session downloadTaskWithResumeData:resumeData];
    } else {
      NSURL *u = [NSURL URLWithString:url];
      if (!u) {
        [self.running removeObjectForKey:cacheKey];
        reject(@"E_INVALID_REF", [NSString stringWithFormat:@"Bad URL: %@", url]);
        return;
      }
      NSMutableURLRequest *req = [NSMutableURLRequest requestWithURL:u];
      if (authHeader.length > 0) {
        [req setValue:authHeader forHTTPHeaderField:@"Authorization"];
      }
      task = [self.session downloadTaskWithRequest:req];
    }
    task.taskDescription = cacheKey;
    r.task = task;
    [task resume];
  });
}

- (void)cancelDownloadForCacheKey:(NSString *)cacheKey {
  dispatch_async(_lockQueue, ^{
    BitnetRunningDownload *r = self.running[cacheKey];
    if (!r) return;
    r.cancelled = YES;
    [r.task cancelByProducingResumeData:^(NSData * _Nullable resumeData) {
      if (resumeData && !r.deletePending) {
        [resumeData writeToFile:[BitnetCache resumeFileForCacheKey:cacheKey]
                     atomically:YES];
      }
    }];
  });
}

- (BOOL)deleteModelRef:(NSString *)modelRef {
  NSString *cacheKey = [BitnetCache cacheKeyFor:modelRef];
  __block BOOL inFlight = NO;
  dispatch_sync(_lockQueue, ^{
    BitnetRunningDownload *r = self.running[cacheKey];
    if (r) {
      inFlight = YES;
      r.deletePending = YES;
      r.cancelled = YES;
      [r.task cancel];
    }
  });
  if (inFlight) {
    // The delegate finishes the cleanup and removes the directory.
    return YES;
  }
  return [BitnetCache deleteModelRef:modelRef];
}

#pragma mark - NSURLSessionDownloadDelegate

- (void)URLSession:(NSURLSession *)session
      downloadTask:(NSURLSessionDownloadTask *)downloadTask
      didWriteData:(int64_t)bytesWritten
 totalBytesWritten:(int64_t)totalBytesWritten
totalBytesExpectedToWrite:(int64_t)totalBytesExpectedToWrite {
  NSString *cacheKey = downloadTask.taskDescription;
  if (!cacheKey) return;
  dispatch_async(_lockQueue, ^{
    BitnetRunningDownload *r = self.running[cacheKey];
    if (!r) return;
    NSTimeInterval now = [NSDate date].timeIntervalSince1970;
    NSTimeInterval elapsed = now - r.lastEmitTime;
    int64_t bytesSinceLast = totalBytesWritten - r.lastEmitBytes;
    if (elapsed >= 0.25 || bytesSinceLast >= 1024 * 1024) {
      int64_t bps = elapsed > 0 ? (int64_t)(bytesSinceLast / elapsed) : 0;
      r.lastEmitTime = now;
      r.lastEmitBytes = totalBytesWritten;
      id<BitnetDownloaderDelegate> d = self.delegate;
      if (d) {
        dispatch_async(dispatch_get_main_queue(), ^{
          [d downloader:self
            didEmitProgress:cacheKey
            bytesDownloaded:totalBytesWritten
                 totalBytes:totalBytesExpectedToWrite
             bytesPerSecond:bps];
        });
      }
    }
  });
}

- (void)URLSession:(NSURLSession *)session
      downloadTask:(NSURLSessionDownloadTask *)downloadTask
didFinishDownloadingToURL:(NSURL *)location {
  NSString *cacheKey = downloadTask.taskDescription;
  if (!cacheKey) return;

  // Must move synchronously inside the delegate callback — iOS deletes the
  // temp file as soon as this method returns.
  NSString *finalPath = [BitnetCache finalFileForCacheKey:cacheKey];
  NSFileManager *fm = [NSFileManager defaultManager];
  if ([fm fileExistsAtPath:finalPath]) {
    [fm removeItemAtPath:finalPath error:nil];
  }
  NSError *moveErr = nil;
  [fm moveItemAtURL:location
              toURL:[NSURL fileURLWithPath:finalPath]
              error:&moveErr];

  // Stream a SHA-256 over the moved file (only if expectedSha256 was set).
  __block BitnetRunningDownload *r = nil;
  dispatch_sync(_lockQueue, ^{ r = self.running[cacheKey]; });
  NSString *actualSha256 = @"";
  if (r && r.expectedSha256.length > 0) {
    actualSha256 = [self sha256OfFile:finalPath];
    if (![actualSha256.lowercaseString isEqualToString:r.expectedSha256.lowercaseString]) {
      [fm removeItemAtPath:finalPath error:nil];
      BitnetCacheMeta *m = [BitnetCache readMetaForCacheKey:cacheKey] ?: [BitnetCacheMeta new];
      m.lastError = @"E_CHECKSUM_MISMATCH";
      m.complete = NO;
      [BitnetCache writeMeta:m forCacheKey:cacheKey];
      dispatch_async(self.lockQueue, ^{
        [self rejectAll:cacheKey code:@"E_CHECKSUM_MISMATCH" message:@"SHA-256 mismatch"];
      });
      return;
    }
  }

  long long now = (long long)([NSDate date].timeIntervalSince1970 * 1000);
  unsigned long long size =
    [[fm attributesOfItemAtPath:finalPath error:nil] fileSize];
  BitnetCacheMeta *meta = [BitnetCache readMetaForCacheKey:cacheKey] ?: [BitnetCacheMeta new];
  meta.modelRef = r.modelRef ?: meta.modelRef;
  meta.resolvedUrl = r.url ?: meta.resolvedUrl;
  meta.complete = YES;
  meta.completedAt = now;
  meta.actualSizeBytes = (long long)size;
  meta.actualSha256 = actualSha256;
  meta.lastError = @"";
  if (meta.expectedSizeBytes < 0) meta.expectedSizeBytes = (long long)size;
  [BitnetCache writeMeta:meta forCacheKey:cacheKey];

  // Clean up resume blob.
  [fm removeItemAtPath:[BitnetCache resumeFileForCacheKey:cacheKey] error:nil];

  NSDictionary *result = @{
    @"localPath": finalPath,
    @"sizeBytes": @(size),
    @"sha256": actualSha256,
    @"resumed": @NO, // URLSession doesn't expose whether it resumed; v1 sets false
  };
  dispatch_async(self.lockQueue, ^{
    [self resolveAll:cacheKey result:result];
  });
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
didCompleteWithError:(NSError *)error {
  NSString *cacheKey = task.taskDescription;
  if (!cacheKey || !error) return; // success path is handled by didFinishDownloadingToURL

  // Persist resumeData if available.
  NSData *resumeData = error.userInfo[NSURLSessionDownloadTaskResumeData];
  __block BitnetRunningDownload *r = nil;
  dispatch_sync(_lockQueue, ^{ r = self.running[cacheKey]; });

  if (r && r.deletePending) {
    [BitnetCache deleteModelRef:r.modelRef];
    dispatch_async(self.lockQueue, ^{
      [self rejectAll:cacheKey code:@"E_DOWNLOAD_CANCELLED" message:@"Cancelled (deleting)"];
    });
    return;
  }

  if (resumeData && r && r.cancelled) {
    [resumeData writeToFile:[BitnetCache resumeFileForCacheKey:cacheKey] atomically:YES];
  }

  NSString *code = @"E_NETWORK";
  if (r && r.cancelled) {
    code = @"E_DOWNLOAD_CANCELLED";
  } else {
    NSInteger ec = error.code;
    if ([error.domain isEqualToString:NSPOSIXErrorDomain] && ec == 28) {
      code = @"E_DISK_FULL";
    } else if ([error.domain isEqualToString:NSURLErrorDomain]) {
      if (ec == NSURLErrorCancelled) code = @"E_DOWNLOAD_CANCELLED";
    }
  }

  if (![code isEqualToString:@"E_DOWNLOAD_CANCELLED"]) {
    BitnetCacheMeta *m = [BitnetCache readMetaForCacheKey:cacheKey] ?: [BitnetCacheMeta new];
    m.lastError = code;
    [BitnetCache writeMeta:m forCacheKey:cacheKey];
  } else if (r) {
    BitnetCacheMeta *m = [BitnetCache readMetaForCacheKey:cacheKey] ?: [BitnetCacheMeta new];
    m.lastError = @"E_DOWNLOAD_CANCELLED";
    [BitnetCache writeMeta:m forCacheKey:cacheKey];
  }

  dispatch_async(self.lockQueue, ^{
    [self rejectAll:cacheKey code:code message:error.localizedDescription ?: code];
  });
}

- (void)URLSessionDidFinishEventsForBackgroundURLSession:(NSURLSession *)session {
  NSString *identifier = session.configuration.identifier;
  if (!identifier) return;
  void (^handler)(void) = sCompletionHandlers[identifier];
  if (handler) {
    [sCompletionHandlers removeObjectForKey:identifier];
    dispatch_async(dispatch_get_main_queue(), handler);
  }
}

#pragma mark - Private

// Always called from lockQueue.
- (void)resolveAll:(NSString *)cacheKey result:(NSDictionary *)result {
  BitnetRunningDownload *r = self.running[cacheKey];
  if (!r) return;
  [self.running removeObjectForKey:cacheKey];
  for (NSUInteger i = 0; i < r.resolvers.count; i++) {
    void (^cb)(NSDictionary *) = r.resolvers[i];
    if (cb) cb(result);
  }
}

// Always called from lockQueue.
- (void)rejectAll:(NSString *)cacheKey code:(NSString *)code message:(NSString *)message {
  BitnetRunningDownload *r = self.running[cacheKey];
  if (!r) return;
  [self.running removeObjectForKey:cacheKey];
  for (NSUInteger i = 0; i < r.rejecters.count; i++) {
    void (^cb)(NSString *, NSString *) = r.rejecters[i];
    if (cb) cb(code, message);
  }
}

- (NSString *)sha256OfFile:(NSString *)path {
  NSInputStream *stream = [NSInputStream inputStreamWithFileAtPath:path];
  [stream open];
  CC_SHA256_CTX ctx;
  CC_SHA256_Init(&ctx);
  uint8_t buf[64 * 1024];
  while (stream.hasBytesAvailable) {
    NSInteger n = [stream read:buf maxLength:sizeof(buf)];
    if (n <= 0) break;
    CC_SHA256_Update(&ctx, buf, (CC_LONG)n);
  }
  [stream close];
  uint8_t out[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(out, &ctx);
  NSMutableString *hex = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
    [hex appendFormat:@"%02x", out[i]];
  }
  return hex;
}

@end
