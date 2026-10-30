/* Headless-only entry point for the separately distributed Office renderer.
 * LibreOffice's normal SAL entry initialization is preserved. Native macOS
 * spellchecking requires GUI registration even for --headless, so use the same
 * no-native-spellchecking policy as the Office plugin's conversion registry.
 * No sandbox permissions or vendor rendering libraries are changed. */
#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <dlfcn.h>
#include <mach-o/dyld.h>
#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>

static id noNativeSpellChecker(id self, SEL selector) {
    (void)self; (void)selector;
    return nil;
}

int main(int argc, char **argv) {
    int headless = 0;
    for (int i = 1; i < argc; ++i) if (!strcmp(argv[i], "--headless")) headless = 1;
    if (!headless) { fprintf(stderr, "This Office renderer only supports --headless.\n"); return 2; }
    @autoreleasepool {
        Method method = class_getClassMethod(objc_getClass("NSSpellChecker"), @selector(sharedSpellChecker));
        if (!method) { fprintf(stderr, "Native spellchecker method unavailable.\n"); return 2; }
        method_setImplementation(method, (IMP)noNativeSpellChecker);
        char executable[PATH_MAX], absolute[PATH_MAX], library[PATH_MAX];
        uint32_t size = sizeof(executable);
        if (_NSGetExecutablePath(executable, &size) || !realpath(executable, absolute)) return 2;
        snprintf(library, sizeof(library), "%s/../Frameworks/libmergedlo.dylib", dirname(absolute));
        void *handle = dlopen(library, RTLD_NOW | RTLD_GLOBAL);
        if (!handle) { fprintf(stderr, "Renderer load failed: %s\n", dlerror()); return 2; }
        void (*initialize)(int, char **) = dlsym(RTLD_DEFAULT, "sal_detail_initialize");
        void (*deinitialize)(void) = dlsym(RTLD_DEFAULT, "sal_detail_deinitialize");
        int (*officeMain)(void) = dlsym(handle, "soffice_main");
        if (!initialize || !deinitialize || !officeMain) { fprintf(stderr, "Renderer entry symbols unavailable.\n"); return 2; }
        initialize(argc, argv);
        int result = officeMain();
        deinitialize();
        return result;
    }
}
