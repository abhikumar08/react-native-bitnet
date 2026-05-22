#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

// On-disk layout under {ApplicationSupport}/bitnet-models/{cacheKey}/:
//   meta.json
//   model.gguf            (final, complete download)
//   model.gguf.part       (in-progress)
//   resume.dat            (NSURLSessionDownloadTask resume data, iOS only)
//
// Keeps no in-memory state — every call re-reads from disk. Mirrors
// android/src/main/java/com/bitnet/ModelCache.kt; the JSON schema must match.

@interface BitnetCacheMeta : NSObject
@property (nonatomic, copy) NSString *modelRef;
@property (nonatomic, copy) NSString *resolvedUrl;
@property (nonatomic, assign) long long expectedSizeBytes;
@property (nonatomic, assign) long long actualSizeBytes;
@property (nonatomic, copy) NSString *etag;
@property (nonatomic, copy) NSString *expectedSha256;
@property (nonatomic, copy) NSString *actualSha256;
@property (nonatomic, assign) long long createdAt;
@property (nonatomic, assign) long long completedAt;
@property (nonatomic, assign) BOOL complete;
@property (nonatomic, copy) NSString *lastError;
@property (nonatomic, assign) NSInteger schemaVersion;

- (NSDictionary *)toDictionary;
+ (BitnetCacheMeta *)fromDictionary:(NSDictionary *)dict;
@end


@interface BitnetCache : NSObject

+ (NSString *)cacheRoot;
+ (NSString *)cacheKeyFor:(NSString *)modelRef;
+ (NSString *)entryDirForCacheKey:(NSString *)cacheKey;
+ (NSString *)partFileForCacheKey:(NSString *)cacheKey;
+ (NSString *)finalFileForCacheKey:(NSString *)cacheKey;
+ (NSString *)metaFileForCacheKey:(NSString *)cacheKey;
+ (NSString *)resumeFileForCacheKey:(NSString *)cacheKey;

+ (nullable BitnetCacheMeta *)readMetaForCacheKey:(NSString *)cacheKey;
+ (BOOL)writeMeta:(BitnetCacheMeta *)meta forCacheKey:(NSString *)cacheKey;

+ (BOOL)deleteModelRef:(NSString *)modelRef;
+ (NSString *)listAsJSON;
+ (BOOL)isCachedModelRef:(NSString *)modelRef;
+ (long long)totalSizeBytes;

+ (void)runCrashRecoverySweep;

@end

NS_ASSUME_NONNULL_END
