#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@class BitnetDownloader;

@protocol BitnetDownloaderDelegate <NSObject>
- (void)downloader:(BitnetDownloader *)downloader
        didEmitProgress:(NSString *)cacheKey
        bytesDownloaded:(int64_t)bytesDownloaded
             totalBytes:(int64_t)totalBytes
         bytesPerSecond:(int64_t)bytesPerSecond;
@end

// Background-capable downloader built on URLSessionDownloadTask. Uses a
// backgroundSessionConfigurationWithIdentifier so iOS keeps the download
// alive when the app is suspended.
//
// HOST APP INTEGRATION (required for downloads to survive app suspension):
//
//   // In your AppDelegate.m / .mm:
//   - (void)application:(UIApplication *)application
//     handleEventsForBackgroundURLSession:(NSString *)identifier
//                       completionHandler:(void (^)(void))completionHandler {
//     [BitnetDownloader storeCompletionHandler:completionHandler
//                               forIdentifier:identifier];
//   }
//
// Without this, downloads still work in the foreground but won't continue
// reliably when the app is backgrounded for long periods.

@interface BitnetDownloader : NSObject

+ (instancetype)sharedInstance;

@property (nonatomic, weak) id<BitnetDownloaderDelegate> delegate;

- (void)startWithCacheKey:(NSString *)cacheKey
                 modelRef:(NSString *)modelRef
                      url:(NSString *)url
               authHeader:(NSString *)authHeader
        expectedSizeBytes:(int64_t)expectedSizeBytes
           expectedSha256:(NSString *)expectedSha256
                  resolve:(void (^)(NSDictionary *result))resolve
                   reject:(void (^)(NSString *code, NSString *message))reject;

- (void)cancelDownloadForCacheKey:(NSString *)cacheKey;
- (BOOL)deleteModelRef:(NSString *)modelRef; // cancels in-flight then removes

- (BOOL)isRunning:(NSString *)cacheKey;
- (BOOL)hasActiveDownloads;

// Called by the host AppDelegate to wire the background-session completion handler.
+ (void)storeCompletionHandler:(void (^)(void))completionHandler
                 forIdentifier:(NSString *)identifier;

@end

NS_ASSUME_NONNULL_END
