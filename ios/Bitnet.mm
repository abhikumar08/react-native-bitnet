#import "Bitnet.h"
#import "BitnetCache.h"

@interface Bitnet () {
  BOOL _hasListeners;
}
@end

@implementation Bitnet

RCT_EXPORT_MODULE()

- (instancetype)init {
  if ((self = [super init])) {
    // Crash-recovery sweep: rewrite any entry that was mid-download last session.
    [BitnetCache runCrashRecoverySweep];
    [BitnetDownloader sharedInstance].delegate = self;
  }
  return self;
}

+ (BOOL)requiresMainQueueSetup {
  return NO;
}

#pragma mark - RCTEventEmitter

- (NSArray<NSString *> *)supportedEvents {
  return @[ @"BitnetToken", @"BitnetDownloadProgress" ];
}

- (void)startObserving {
  _hasListeners = YES;
}

- (void)stopObserving {
  _hasListeners = NO;
}

#pragma mark - BitnetDownloaderDelegate

- (void)downloader:(BitnetDownloader *)downloader
        didEmitProgress:(NSString *)cacheKey
        bytesDownloaded:(int64_t)bytesDownloaded
             totalBytes:(int64_t)totalBytes
         bytesPerSecond:(int64_t)bytesPerSecond {
  if (!_hasListeners) return;
  [self sendEventWithName:@"BitnetDownloadProgress" body:@{
    @"cacheKey": cacheKey,
    @"bytesDownloaded": @(bytesDownloaded),
    @"totalBytes": @(totalBytes),
    @"bytesPerSecond": @(bytesPerSecond),
  }];
}

#pragma mark - Engine methods (still stubbed — iOS engine port pending)

- (void)loadModel:(NSString *)modelPath
             nCtx:(double)nCtx
         nThreads:(double)nThreads
           nBatch:(double)nBatch
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  reject(@"E_NOT_IMPLEMENTED",
         @"iOS engine is not yet wired. The lifecycle APIs (Models.download, etc.) work; "
         @"the inference engine port is in progress.",
         nil);
}

- (void)disposeEngine:(double)handle {
  // no-op — engine not yet wired
}

- (void)generate:(double)handle
                prompt:(NSString *)prompt
             maxTokens:(double)maxTokens
           temperature:(double)temperature
                  topK:(double)topK
                  topP:(double)topP
                  seed:(double)seed
     stopSequencesJson:(NSString *)stopSequencesJson
         repeatPenalty:(double)repeatPenalty
           repeatLastN:(double)repeatLastN
      frequencyPenalty:(double)frequencyPenalty
       presencePenalty:(double)presencePenalty
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  reject(@"E_NOT_IMPLEMENTED", @"iOS engine not yet wired", nil);
}

- (void)cancelGeneration:(double)handle {
  // no-op
}

- (void)applyChatTemplate:(double)handle
                rolesJson:(NSString *)rolesJson
       addAssistantHeader:(BOOL)addAssistantHeader
                  resolve:(RCTPromiseResolveBlock)resolve
                   reject:(RCTPromiseRejectBlock)reject {
  reject(@"E_NOT_IMPLEMENTED", @"iOS engine not yet wired", nil);
}

- (void)getModelInfo:(double)handle
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  reject(@"E_NOT_IMPLEMENTED", @"iOS engine not yet wired", nil);
}

#pragma mark - Lifecycle methods (active on iOS today)

- (void)startDownload:(NSString *)cacheKey
             modelRef:(NSString *)modelRef
                  url:(NSString *)url
           authHeader:(NSString *)authHeader
    expectedSizeBytes:(double)expectedSizeBytes
       expectedSha256:(NSString *)expectedSha256
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  [[BitnetDownloader sharedInstance]
    startWithCacheKey:cacheKey
             modelRef:modelRef
                  url:url
           authHeader:authHeader
    expectedSizeBytes:(int64_t)expectedSizeBytes
       expectedSha256:expectedSha256
              resolve:^(NSDictionary *result) { resolve(result); }
               reject:^(NSString *code, NSString *message) {
                 reject(code, message, nil);
               }];
}

- (void)cancelDownload:(NSString *)cacheKey {
  [[BitnetDownloader sharedInstance] cancelDownloadForCacheKey:cacheKey];
}

- (void)listModels:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject {
  @try {
    resolve([BitnetCache listAsJSON]);
  } @catch (NSException *e) {
    reject(@"E_CACHE", e.reason ?: @"listModels threw", nil);
  }
}

- (void)deleteModel:(NSString *)modelRef
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject {
  @try {
    BOOL ok = [[BitnetDownloader sharedInstance] deleteModelRef:modelRef];
    resolve(@(ok));
  } @catch (NSException *e) {
    reject(@"E_CACHE", e.reason ?: @"deleteModel threw", nil);
  }
}

- (void)getCacheSize:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  resolve(@([BitnetCache totalSizeBytes]));
}

- (void)getCacheDir:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject {
  resolve([BitnetCache cacheRoot]);
}

- (void)isModelCached:(NSString *)modelRef
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  resolve(@([BitnetCache isCachedModelRef:modelRef]));
}

#pragma mark - TurboModule

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeBitnetSpecJSI>(params);
}

@end
