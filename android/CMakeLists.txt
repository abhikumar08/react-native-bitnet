cmake_minimum_required(VERSION 3.22)
project(bitnet_rn CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(CPP_DIR ${CMAKE_CURRENT_SOURCE_DIR}/src/main/cpp)
set(JNILIBS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/src/main/jniLibs/${ANDROID_ABI})

# Pre-built libraries — declare all three before anything else uses them.
add_library(llama_prebuilt SHARED IMPORTED)
set_target_properties(llama_prebuilt PROPERTIES
    IMPORTED_LOCATION ${JNILIBS_DIR}/libllama.so)

add_library(ggml_prebuilt SHARED IMPORTED)
set_target_properties(ggml_prebuilt PROPERTIES
    IMPORTED_LOCATION ${JNILIBS_DIR}/libggml.so)

add_library(common_prebuilt STATIC IMPORTED)
set_target_properties(common_prebuilt PROPERTIES
    IMPORTED_LOCATION ${JNILIBS_DIR}/libcommon.a)

# Our library.
add_library(bitnet_rn SHARED
    ${CPP_DIR}/bitnet_engine.cpp
    ${CPP_DIR}/bitnet_jni.cpp
)

# Force default symbol visibility — without this, NDK's default-hidden
# behavior strips JNIEXPORT symbols from the dynamic symbol table even
# though they survive in the text section. The JVM resolves JNI calls
# via dlsym(), which only sees the dynamic table.
set_target_properties(bitnet_rn PROPERTIES
    CXX_VISIBILITY_PRESET default
    C_VISIBILITY_PRESET default
    VISIBILITY_INLINES_HIDDEN OFF
)

target_compile_options(bitnet_rn PRIVATE
    -fvisibility=default
)

target_include_directories(bitnet_rn PRIVATE
    ${CPP_DIR}
    ${CPP_DIR}/include/llama
    ${CPP_DIR}/include/common
    ${CPP_DIR}/include/ggml
)

target_link_libraries(bitnet_rn
    PRIVATE
        common_prebuilt
        llama_prebuilt
        ggml_prebuilt
        android
        log
)