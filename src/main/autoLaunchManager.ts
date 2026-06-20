import { app } from 'electron';

export function getAutoLaunchEnabled(): boolean {
  try {
    // Windows: must pass the same args used in setLoginItemSettings,
    // otherwise openAtLogin defaults to comparing against [] which
    // won't match the registered ['--auto-launched'] and returns false.
    const settings = app.getLoginItemSettings({
      args: ['--auto-launched'],
    });
    return settings.openAtLogin;
  } catch (error) {
    console.error('Failed to get auto-launch settings:', error);
    return false;
  }
}

export function setAutoLaunchEnabled(enabled: boolean): void {
  const isMac = process.platform === 'darwin';

  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      // macOS: Hide window after auto-launch, compatible with both M-series and Intel chips
      openAsHidden: isMac ? enabled : false,
      // Windows: Mark auto-launch via command line arguments
      args: enabled ? ['--auto-launched'] : [],
    });
  } catch (error) {
    console.error('Failed to set auto-launch settings:', error);
    throw error;
  }
}

export function isAutoLaunched(): boolean {
  try {
    if (process.platform === 'darwin') {
      const settings = app.getLoginItemSettings();
      return settings.wasOpenedAtLogin || false;
    }
    // Windows: Check command line arguments
    return process.argv.includes('--auto-launched');
  } catch (error) {
    console.error('Failed to check auto-launch status:', error);
    return false;
  }
}
