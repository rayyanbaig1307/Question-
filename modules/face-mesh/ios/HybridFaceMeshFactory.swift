import Foundation
import NitroModules
import VisionCamera

// Makes face mesh camera outputs. JS reaches it with NitroModules.createHybridObject('FaceMeshFactory').
class HybridFaceMeshFactory: HybridFaceMeshFactorySpec {
  func isModelReady() throws -> Bool {
    return FaceMeshModel.path() != nil
  }

  func createFaceMeshOutput(options: FaceMeshOutputOptions) throws -> any HybridCameraOutputSpec {
    return HybridFaceMeshOutput(options)
  }
}

// Finds face_landmarker.task inside the app. The podspec copies it into a "PeekabooFaceMesh.bundle"; we also
// look in the main app folder in case a build puts it there instead.
enum FaceMeshModel {
  static func path() -> String? {
    let candidates: [Bundle] = [
      Bundle.main.url(forResource: "PeekabooFaceMesh", withExtension: "bundle").flatMap { Bundle(url: $0) },
      Bundle(for: HybridFaceMeshFactory.self).url(forResource: "PeekabooFaceMesh", withExtension: "bundle")
        .flatMap { Bundle(url: $0) },
      Bundle(for: HybridFaceMeshFactory.self),
      Bundle.main,
    ].compactMap { $0 }
    for bundle in candidates {
      if let path = bundle.path(forResource: "face_landmarker", ofType: "task") {
        return path
      }
    }
    return nil
  }
}
