// Adds settings to app.json that come from Expo's servers instead of the code.
//
// Android friend map: Google Maps on Android needs an API key, or the map stays grey. The key lives in the EAS
// environment variable GOOGLE_MAPS_ANDROID_API_KEY (expo.dev → peekaboo → Environment variables), so it's never
// in the code. It only matters for Android builds – iPhones use Apple Maps and need nothing.
// Without the variable, everything works as before (just a grey map on Android).
module.exports = ({ config }) => {
  const mapsKey = process.env.GOOGLE_MAPS_ANDROID_API_KEY;
  if (!mapsKey) return config;
  return {
    ...config,
    android: {
      ...config.android,
      config: { ...config.android?.config, googleMaps: { apiKey: mapsKey } },
    },
  };
};
