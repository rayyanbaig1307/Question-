// Adds the Peekaboo+ app icons to the iPhone app. The switching itself is done by expo-alternate-app-icons
// (src/lib/appIcons.ts); this small plugin does the build set-up its own plugin would do, for iPhone only.
//
// Why not the package's own plugin?
//  - It also adds an Android launcher entry for every icon, pointing at Android icon files we don't make
//    (Android is paused), so the Android build would fail.
//  - It re-saves each picture with a see-through layer. Apple wants icons without one, so here the pictures
//    are copied exactly as scripts/make-plus-icons.py made them (1024 × 1024, no see-through layer).
//
// app.json passes the list: [{ "name": "DarkGold", "ios": "./assets/icons/dark-gold.png" }, …].
// Names must be PascalCase and must match src/lib/appIcons.ts. Changing this needs a new app build.
const fs = require('fs');
const path = require('path');
const { IOSConfig, withDangerousMod, withXcodeProject } = require('expo/config-plugins');

module.exports = function withIosAppIcons(config, icons = []) {
  if (!icons.length) return config;
  for (const icon of icons) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(icon.name)) throw new Error(`App icon name "${icon.name}" must be PascalCase.`);
    if (typeof icon.ios !== 'string' || !icon.ios.endsWith('.png')) throw new Error(`App icon "${icon.name}" needs an "ios" .png picture.`);
  }

  // Each picture goes into ios/<app>/Images.xcassets/<Name>.appiconset, with the little file Xcode reads.
  config = withDangerousMod(config, [
    'ios',
    async (config) => {
      const root = config.modRequest.projectRoot;
      const assets = path.join(root, 'ios', IOSConfig.XcodeUtils.getProjectName(root), 'Images.xcassets');
      for (const icon of icons) {
        const folder = path.join(assets, `${icon.name}.appiconset`);
        const file = path.basename(icon.ios);
        fs.mkdirSync(folder, { recursive: true });
        fs.copyFileSync(path.join(root, icon.ios), path.join(folder, file));
        const contents = {
          images: [{ filename: file, idiom: 'universal', platform: 'ios', size: '1024x1024' }],
          info: { author: 'expo', version: 1 },
        };
        fs.writeFileSync(path.join(folder, 'Contents.json'), JSON.stringify(contents, null, 2));
      }
      return config;
    },
  ]);

  // Tells Xcode to build them as extra app icons.
  config = withXcodeProject(config, (config) => {
    config.modResults.updateBuildProperty(
      'ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES',
      icons.map((icon) => icon.name),
    );
    return config;
  });
  return config;
};
