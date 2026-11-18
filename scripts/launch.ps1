param([switch]$Background)
$ErrorActionPreference='Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$dataRoot = Join-Path $env:LOCALAPPDATA 'Menki'
$nodePath = (Get-Command node.exe).Source
$scriptPath = Join-Path $projectRoot 'dist/server/main.js'
New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
$ready = $false
try { $probe = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/health' -TimeoutSec 2; $ready = $probe.app -eq 'menki' } catch {}
if (!$ready) {
  if (!(Test-Path -LiteralPath $scriptPath)) { throw 'Construire Menki avec npm run build avant le premier lancement.' }
  $process = Start-Process -FilePath $nodePath -ArgumentList @('"' + $scriptPath + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataRoot 'service.log') -RedirectStandardError (Join-Path $dataRoot 'service-errors.log')
  $process.Id | Set-Content -LiteralPath (Join-Path $dataRoot 'service.pid')
  for($attempt=0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    try { $probe = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/health' -TimeoutSec 2; if ($probe.app -eq 'menki') { $ready=$true; break } } catch {}
    if($process.HasExited) { throw 'Le service Menki a quitté. Consulter service-errors.log dans le profil Menki.' }
  }
}
if (!$ready) { throw 'Menki ne répond pas sur le port local 4317.' }
if (!$Background) {
  $authPath=Join-Path $dataRoot 'browser-auth.json'
  $auth = Get-Content -Raw -LiteralPath $authPath | ConvertFrom-Json
  Start-Process ('http://127.0.0.1:4317/#connect=' + $auth.bootstrap)
}
