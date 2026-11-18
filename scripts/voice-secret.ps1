param([ValidateSet('Protect','Unprotect')][string]$Mode)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
  if ($Mode -eq 'Protect') {
    $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  } else {
    $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
  }
  [Console]::Out.Write([Convert]::ToBase64String($result))
} catch {
  [Console]::Error.Write('Windows ne peut pas ouvrir le coffre vocal de cet utilisateur.')
  exit 1
}
