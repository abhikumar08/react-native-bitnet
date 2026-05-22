#import <BitnetSpec/BitnetSpec.h>
#import <React/RCTEventEmitter.h>
#import "BitnetDownloader.h"

@interface Bitnet : RCTEventEmitter <NativeBitnetSpec, BitnetDownloaderDelegate>

@end
