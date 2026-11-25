import { existsSync } from "node:fs";
import { dirname, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));

const ENV_KEYS = {
  ffmpeg: "EAOL_FFMPEG",
  ffprobe: "EAOL_FFPROBE",
  whisper: "EAOL_WHISPER_CLI",
};

export function toolCandidates(tool, {
  platform = process.platform,
  env = process.env,
  root = ROOT,
} = {}) {
  const override = env[ENV_KEYS[tool]];
  const candidates = override ? [override] : [];

  if (tool === "whisper") {
    if (platform === "win32") {
      candidates.push(
        win32.join(root, ".local", "whisper", "Release", "whisper-cli.exe"),
        win32.join(root, ".local", "whisper", "whisper-cli.exe"),
        "whisper-cli.exe",
      );
    } else {
      candidates.push("whisper-cli");
    }
    return candidates;
  }

  if (platform === "darwin") {
    candidates.push(posix.join("/opt/homebrew/opt/ffmpeg-full/bin", tool));
  }
  candidates.push(tool);
  return candidates;
}

export function resolveTool(tool, options = {}) {
  const candidates = toolCandidates(tool, options);
  if (options.env?.[ENV_KEYS[tool]] || (!options.env && process.env[ENV_KEYS[tool]])) return candidates[0];
  const fileExists = options.exists || existsSync;
  return candidates.find((candidate) => candidate.includes("/") || candidate.includes("\\") ? fileExists(candidate) : false)
    || candidates[candidates.length - 1];
}

export function setupHint(platform = process.platform) {
  if (platform === "win32") {
    return "Install ffmpeg (with libass), ffprobe, Node.js 20+, and whisper.cpp, then set EAOL_FFMPEG, EAOL_FFPROBE and EAOL_WHISPER_CLI or place them on PATH.";
  }
  if (platform === "darwin") return "Run: brew install ffmpeg-full whisper-cpp node";
  return "Install ffmpeg (with libass), ffprobe, Node.js, and whisper.cpp, then place them on PATH.";
}

export function folderOpenCommand(platform = process.platform) {
  if (platform === "darwin") return "open";
  if (platform === "win32") return "explorer";
  return "xdg-open";
}

export function filePickerCommand(kind, platform = process.platform) {
  const audio = kind === "audio";
  const visual = kind === "visual";
  const csv = kind === "csv";
  if (platform === "win32") {
    const filter = csv
      ? "CSV files|*.csv|All files|*.*"
      : audio
      ? "Audio files|*.wav;*.m4a;*.mp3;*.flac;*.aac|All files|*.*"
      : visual
        ? "Visual files|*.mp4;*.mov;*.m4v;*.mkv;*.png;*.jpg;*.jpeg;*.webp|All files|*.*"
        : "Video files|*.mp4;*.mov;*.m4v;*.mkv|All files|*.*";
    const label = csv ? "CSV file" : audio ? "audio track" : visual ? "visual asset" : "camera recording";
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.OpenFileDialog",
      `$dialog.Title = 'Choose a podcast ${label}'`,
      `$dialog.Filter = '${filter}'`,
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) } else { exit 1 }",
    ].join("; ");
    return { command: "powershell.exe", args: ["-NoProfile", "-STA", "-Command", script] };
  }
  if (platform === "darwin") {
    const label = csv ? "CSV file" : audio ? "audio track" : visual ? "visual asset" : "camera recording";
    const types = csv
      ? '"public.comma-separated-values-text", "public.text"'
      : audio
        ? '"public.audio"'
        : visual
          ? '"public.movie", "public.image"'
          : '"public.movie"';
    const script = `POSIX path of (choose file with prompt "Choose a podcast ${label}" of type {${types}})`;
    return { command: "osascript", args: ["-e", script] };
  }
  return null;
}

export function folderPickerCommand(platform = process.platform) {
  if (platform === "win32") {
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = 'Choose a folder'",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) } else { exit 1 }",
    ].join("; ");
    return { command: "powershell.exe", args: ["-NoProfile", "-STA", "-Command", script] };
  }
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: ["-e", 'POSIX path of (choose folder with prompt "Choose the mounted Podcast folder")'],
    };
  }
  return null;
}
