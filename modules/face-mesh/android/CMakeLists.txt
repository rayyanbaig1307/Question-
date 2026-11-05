project(PeekabooFaceMesh)
cmake_minimum_required(VERSION 3.9.0)

set (PACKAGE_NAME PeekabooFaceMesh)
set (CMAKE_VERBOSE_MAKEFILE ON)
set (CMAKE_CXX_STANDARD 20)

# The only C++ here is Nitro's generated glue; the real work is in Kotlin.
add_library(${PACKAGE_NAME} SHARED
        src/main/cpp/cpp-adapter.cpp
)

include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/PeekabooFaceMesh+autolinking.cmake)

include_directories(
        "src/main/cpp"
)

find_library(LOG_LIB log)
find_package(react-native-vision-camera REQUIRED)   # <-- for HybridCameraOutputSpec

target_link_libraries(
        ${PACKAGE_NAME}
        ${LOG_LIB}
        android
        react-native-vision-camera::VisionCamera
)
