// Google sign-in is only used on Android (iPhones use Sign in with Apple), so leave it out of the iPhone app.
module.exports = {
  dependencies: {
    '@react-native-google-signin/google-signin': {
      platforms: { ios: null },
    },
  },
};
