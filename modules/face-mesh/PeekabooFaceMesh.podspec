require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# Peekaboo's MediaPipe face mesh camera output (see docs/FACE_MESH.md).
Pod::Spec.new do |s|
  s.name         = 'PeekabooFaceMesh'
  s.version      = package['version']
  s.summary      = package['description']
  s.homepage     = 'https://peekaboo-4gz.pages.dev'
  s.license      = package['license']
  s.authors      = 'Peekaboo'

  s.platforms    = { :ios => '15.5' }
  s.source       = { :git => 'https://example.invalid/peekaboo-face-mesh.git', :tag => "#{s.version}" }

  s.source_files = [
    'ios/**/*.{swift}',
    'ios/**/*.{m,mm}',
  ]
  s.frameworks = ['AVFoundation']

  # The face model (3.6 MB). It goes into PeekabooFaceMesh.bundle inside the app.
  s.resource_bundles = { 'PeekabooFaceMesh' => ['assets/face_landmarker.task'] }

  load 'nitrogen/generated/ios/PeekabooFaceMesh+autolinking.rb'
  add_nitrogen_files(s)

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  s.dependency 'VisionCamera'
  # Google's MediaPipe Tasks for iPhone (it brings MediaPipeTasksCommon with it).
  s.dependency 'MediaPipeTasksVision', '0.10.21'
  install_modules_dependencies(s)
end
