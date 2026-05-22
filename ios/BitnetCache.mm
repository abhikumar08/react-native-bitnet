#import "BitnetCache.h"
#import <CommonCrypto/CommonDigest.h>

static NSString *const kDirName = @"bitnet-models";
static NSString *const kMetaName = @"meta.json";
static NSString *const kPartName = @"model.gguf.part";
static NSString *const kFinalName = @"model.gguf";
static NSString *const kResumeName = @"resume.dat";

@implementation BitnetCacheMeta

- (instancetype)init {
  if ((self = [super init])) {
    _modelRef = @"";
    _resolvedUrl = @"";
    _expectedSizeBytes = -1;
    _actualSizeBytes = -1;
    _etag = @"";
    _expectedSha256 = @"";
    _actualSha256 = @"";
    _createdAt = 0;
    _completedAt = 0;
    _complete = NO;
    _lastError = @"";
    _schemaVersion = 1;
  }
  return self;
}

- (NSDictionary *)toDictionary {
  return @{
    @"modelRef": _modelRef ?: @"",
    @"resolvedUrl": _resolvedUrl ?: @"",
    @"expectedSizeBytes": @(_expectedSizeBytes),
    @"actualSizeBytes": @(_actualSizeBytes),
    @"etag": _etag ?: @"",
    @"expectedSha256": _expectedSha256 ?: @"",
    @"actualSha256": _actualSha256 ?: @"",
    @"createdAt": @(_createdAt),
    @"completedAt": @(_completedAt),
    @"complete": @(_complete),
    @"lastError": _lastError ?: @"",
    @"schemaVersion": @(_schemaVersion),
  };
}

+ (BitnetCacheMeta *)fromDictionary:(NSDictionary *)dict {
  BitnetCacheMeta *m = [BitnetCacheMeta new];
  m.modelRef = dict[@"modelRef"] ?: @"";
  m.resolvedUrl = dict[@"resolvedUrl"] ?: @"";
  m.expectedSizeBytes = [dict[@"expectedSizeBytes"] longLongValue];
  m.actualSizeBytes = [dict[@"actualSizeBytes"] longLongValue];
  m.etag = dict[@"etag"] ?: @"";
  m.expectedSha256 = dict[@"expectedSha256"] ?: @"";
  m.actualSha256 = dict[@"actualSha256"] ?: @"";
  m.createdAt = [dict[@"createdAt"] longLongValue];
  m.completedAt = [dict[@"completedAt"] longLongValue];
  m.complete = [dict[@"complete"] boolValue];
  m.lastError = dict[@"lastError"] ?: @"";
  NSNumber *sv = dict[@"schemaVersion"];
  m.schemaVersion = sv ? sv.integerValue : 1;
  return m;
}

@end


@implementation BitnetCache

+ (NSString *)cacheRoot {
  NSError *error = nil;
  NSURL *appSupport = [[NSFileManager defaultManager]
    URLForDirectory:NSApplicationSupportDirectory
           inDomain:NSUserDomainMask
  appropriateForURL:nil
             create:YES
              error:&error];
  if (!appSupport) {
    // Fallback to caches if Application Support is unavailable.
    appSupport = [[NSFileManager defaultManager]
      URLForDirectory:NSCachesDirectory inDomain:NSUserDomainMask
    appropriateForURL:nil create:YES error:nil];
  }
  NSString *root = [appSupport.path stringByAppendingPathComponent:kDirName];
  [[NSFileManager defaultManager] createDirectoryAtPath:root
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:nil];
  return root;
}

+ (NSString *)cacheKeyFor:(NSString *)modelRef {
  NSData *data = [modelRef dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char hash[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, hash);
  NSMutableString *hex = [NSMutableString stringWithCapacity:16];
  for (int i = 0; i < 8; i++) {
    [hex appendFormat:@"%02x", hash[i]];
  }
  return hex;
}

+ (NSString *)entryDirForCacheKey:(NSString *)cacheKey {
  NSString *dir = [[self cacheRoot] stringByAppendingPathComponent:cacheKey];
  [[NSFileManager defaultManager] createDirectoryAtPath:dir
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:nil];
  return dir;
}

+ (NSString *)partFileForCacheKey:(NSString *)cacheKey {
  return [[self entryDirForCacheKey:cacheKey] stringByAppendingPathComponent:kPartName];
}

+ (NSString *)finalFileForCacheKey:(NSString *)cacheKey {
  return [[self entryDirForCacheKey:cacheKey] stringByAppendingPathComponent:kFinalName];
}

+ (NSString *)metaFileForCacheKey:(NSString *)cacheKey {
  return [[self entryDirForCacheKey:cacheKey] stringByAppendingPathComponent:kMetaName];
}

+ (NSString *)resumeFileForCacheKey:(NSString *)cacheKey {
  return [[self entryDirForCacheKey:cacheKey] stringByAppendingPathComponent:kResumeName];
}

+ (BitnetCacheMeta *)readMetaForCacheKey:(NSString *)cacheKey {
  NSString *path = [self metaFileForCacheKey:cacheKey];
  if (![[NSFileManager defaultManager] fileExistsAtPath:path]) return nil;
  NSData *data = [NSData dataWithContentsOfFile:path];
  if (!data) return nil;
  NSError *e = nil;
  NSDictionary *json = [NSJSONSerialization JSONObjectWithData:data options:0 error:&e];
  if (!json || ![json isKindOfClass:[NSDictionary class]]) return nil;
  return [BitnetCacheMeta fromDictionary:json];
}

+ (BOOL)writeMeta:(BitnetCacheMeta *)meta forCacheKey:(NSString *)cacheKey {
  NSString *finalPath = [self metaFileForCacheKey:cacheKey];
  NSString *tmpPath = [finalPath stringByAppendingPathExtension:@"tmp"];
  NSError *e = nil;
  NSData *json = [NSJSONSerialization dataWithJSONObject:meta.toDictionary
                                                 options:0
                                                   error:&e];
  if (!json) return NO;
  if (![json writeToFile:tmpPath options:NSDataWritingAtomic error:&e]) return NO;
  NSFileManager *fm = [NSFileManager defaultManager];
  if ([fm fileExistsAtPath:finalPath]) [fm removeItemAtPath:finalPath error:nil];
  return [fm moveItemAtPath:tmpPath toPath:finalPath error:nil];
}

+ (BOOL)deleteModelRef:(NSString *)modelRef {
  NSString *cacheKey = [self cacheKeyFor:modelRef];
  NSString *dir = [self entryDirForCacheKey:cacheKey];
  NSFileManager *fm = [NSFileManager defaultManager];
  if (![fm fileExistsAtPath:dir]) return NO;
  return [fm removeItemAtPath:dir error:nil];
}

+ (NSString *)listAsJSON {
  NSMutableArray *out = [NSMutableArray array];
  NSFileManager *fm = [NSFileManager defaultManager];
  NSError *e = nil;
  NSArray *children = [fm contentsOfDirectoryAtPath:[self cacheRoot] error:&e] ?: @[];
  for (NSString *child in children) {
    NSString *childPath = [[self cacheRoot] stringByAppendingPathComponent:child];
    BOOL isDir = NO;
    if (![fm fileExistsAtPath:childPath isDirectory:&isDir] || !isDir) continue;
    BitnetCacheMeta *meta = [self readMetaForCacheKey:child];
    if (!meta) continue;
    NSString *finalPath = [self finalFileForCacheKey:child];
    NSString *partPath = [self partFileForCacheKey:child];
    BOOL finalExists = [fm fileExistsAtPath:finalPath];
    BOOL partExists = [fm fileExistsAtPath:partPath];
    BOOL complete = meta.complete && finalExists;
    NSString *localPath = nil;
    long long sizeBytes = 0;
    if (complete) {
      localPath = finalPath;
      sizeBytes = [[fm attributesOfItemAtPath:finalPath error:nil] fileSize];
    } else if (partExists) {
      localPath = partPath;
      sizeBytes = [[fm attributesOfItemAtPath:partPath error:nil] fileSize];
    } else {
      continue;
    }
    NSMutableDictionary *entry = [NSMutableDictionary dictionary];
    entry[@"modelRef"] = meta.modelRef;
    entry[@"cacheKey"] = child;
    entry[@"localPath"] = localPath;
    entry[@"sizeBytes"] = @(sizeBytes);
    entry[@"expectedSizeBytes"] = @(meta.expectedSizeBytes);
    entry[@"complete"] = @(complete);
    entry[@"createdAt"] = @(meta.createdAt);
    entry[@"completedAt"] = @(meta.completedAt);
    entry[@"sha256"] = meta.actualSha256 ?: @"";
    entry[@"etag"] = meta.etag ?: @"";
    if (meta.lastError.length > 0) entry[@"lastError"] = meta.lastError;
    entry[@"resolvedUrl"] = meta.resolvedUrl ?: @"";
    [out addObject:entry];
  }
  NSError *je = nil;
  NSData *jdata = [NSJSONSerialization dataWithJSONObject:out options:0 error:&je];
  if (!jdata) return @"[]";
  return [[NSString alloc] initWithData:jdata encoding:NSUTF8StringEncoding];
}

+ (BOOL)isCachedModelRef:(NSString *)modelRef {
  NSString *cacheKey = [self cacheKeyFor:modelRef];
  BitnetCacheMeta *meta = [self readMetaForCacheKey:cacheKey];
  if (!meta || !meta.complete) return NO;
  return [[NSFileManager defaultManager] fileExistsAtPath:[self finalFileForCacheKey:cacheKey]];
}

+ (long long)totalSizeBytes {
  NSFileManager *fm = [NSFileManager defaultManager];
  NSString *root = [self cacheRoot];
  NSDirectoryEnumerator *enumerator = [fm enumeratorAtPath:root];
  long long total = 0;
  NSString *path;
  while ((path = enumerator.nextObject)) {
    NSDictionary *attrs = enumerator.fileAttributes;
    if ([attrs[NSFileType] isEqualToString:NSFileTypeRegular]) {
      total += [attrs[NSFileSize] longLongValue];
    }
  }
  return total;
}

+ (void)runCrashRecoverySweep {
  NSFileManager *fm = [NSFileManager defaultManager];
  NSError *e = nil;
  NSArray *children = [fm contentsOfDirectoryAtPath:[self cacheRoot] error:&e] ?: @[];
  for (NSString *child in children) {
    NSString *childPath = [[self cacheRoot] stringByAppendingPathComponent:child];
    BOOL isDir = NO;
    if (![fm fileExistsAtPath:childPath isDirectory:&isDir] || !isDir) continue;
    BitnetCacheMeta *meta = [self readMetaForCacheKey:child];
    if (!meta) continue;
    if (meta.complete) {
      if (![fm fileExistsAtPath:[self finalFileForCacheKey:child]]) {
        [fm removeItemAtPath:childPath error:nil];
      }
      continue;
    }
    if (meta.lastError.length == 0) {
      meta.lastError = @"E_INTERRUPTED";
      [self writeMeta:meta forCacheKey:child];
    }
  }
}

@end
