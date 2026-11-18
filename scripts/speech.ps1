param(
  [ValidateSet('recognize','speak')][string]$Mode,
  [ValidateSet('fr-FR','en-US')][string]$Culture='fr-FR',
  [string]$InputFile,
  [string]$OutputFile
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
if ($Mode -eq 'recognize') {
  $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine([System.Globalization.CultureInfo]::GetCultureInfo($Culture))
  try {
    $engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $engine.SetInputToWaveFile($InputFile)
    $parts = New-Object 'System.Collections.Generic.List[string]'
    while ($true) {
      try { $recognized = $engine.Recognize() }
      catch {
        if ($parts.Count -gt 0 -and $_.Exception.InnerException -is [System.InvalidOperationException]) { break }
        throw
      }
      if ($null -eq $recognized) { break }
      $parts.Add($recognized.Text)
    }
    [System.IO.File]::WriteAllText($OutputFile, ($parts -join ' '), (New-Object System.Text.UTF8Encoding($false)))
  } finally { $engine.Dispose() }
} else {
  $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
  try {
    $voice.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [System.Globalization.CultureInfo]::GetCultureInfo($Culture))
    $voice.SetOutputToWaveFile($OutputFile)
    $voice.Speak([System.IO.File]::ReadAllText($InputFile))
  } finally { $voice.Dispose() }
}
