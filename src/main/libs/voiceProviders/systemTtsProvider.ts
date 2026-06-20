/**
 * System TTS Provider — uses platform-native TTS.
 * macOS: say command, Windows: SAPI/PowerShell, Linux: espeak/festival
 *
 * Reference: OpenClaw src/tts/ sherpa-onnx + system TTS fallback
 */

import { execSync, spawn, type ChildProcess } from 'child_process';
import type { TTSProvider } from '../voiceProviderRegistry';
import { coworkLog } from '../coworkLogger';

let speaking = false;
let currentProcess: ChildProcess | null = null;

export const systemTtsProvider: TTSProvider = {
  name: 'system',
  type: 'tts',

  isAvailable(): boolean {
    return true; // System TTS is always available
  },

  async speak(text: string, options?: { voice?: string; speed?: number }): Promise<void> {
    if (speaking) this.stop();

    const cleanText = text.replace(/["`$\\]/g, '').slice(0, 5000);
    speaking = true;

    try {
      if (process.platform === 'darwin') {
        const voice = options?.voice || 'Samantha';
        const rate = options?.speed ? Math.round(options.speed * 200) : 200;
        await execAsync(`say -v "${voice}" -r ${rate} "${cleanText.replace(/"/g, '\\"')}"`);
      } else if (process.platform === 'win32') {
        const rate = options?.speed ? Math.round((options.speed - 1) * 5) : 0; // -10 to 10
        await execAsync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = ${rate}; $s.Speak('${cleanText.replace(/'/g, "''")}'); $s.Dispose()"`);
      } else {
        // Linux: try espeak, then festival
        try {
          await execAsync(`espeak "${cleanText.replace(/"/g, '\\"')}"`);
        } catch {
          await execAsync(`echo "${cleanText.replace(/"/g, '\\"')}" | festival --tts`);
        }
      }
    } finally {
      speaking = false;
      currentProcess = null;
    }
  },

  stop(): void {
    speaking = false;
    if (currentProcess && !currentProcess.killed) {
      currentProcess.kill();
      currentProcess = null;
    }
  },

  isSpeaking(): boolean {
    return speaking;
  },
};

function execAsync(cmd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    currentProcess = spawn(process.platform === 'win32' ? 'cmd' : 'sh',
      process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd],
      { stdio: 'ignore', windowsHide: true }
    );
    currentProcess.on('exit', (code) => {
      currentProcess = null;
      code === 0 ? resolve() : reject(new Error(`TTS exit code: ${code}`));
    });
    currentProcess.on('error', (err) => {
      currentProcess = null;
      reject(err);
    });
  });
}

// ── List available system voices ──

export function listSystemVoices(): string[] {
  try {
    if (process.platform === 'darwin') {
      const out = execSync('say -v "?"', { encoding: 'utf8', timeout: 5000 });
      return out.split('\n').filter(l => l.trim()).map(l => l.split(/\s{2,}/)[0].trim());
    } else if (process.platform === 'win32') {
      const out = execSync('powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }"', { encoding: 'utf8', timeout: 5000 });
      return out.split('\n').filter(l => l.trim());
    }
  } catch {}
  return [];
}
