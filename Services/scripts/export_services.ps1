$ts = (Get-Date).ToString("yyyyMMdd_HHmmss")
$zipName = "NovaServices_$ts.zip"
$destDir = "../Exports"
$tempParent = "./_export_temp"
$tempDir = "$tempParent/Services"

if (!(Test-Path $destDir)) {
    New-Item -ItemType Directory -Path $destDir | Out-Null
}
if (Test-Path $tempParent) {
    Remove-Item -Recurse -Force $tempParent
}
New-Item -ItemType Directory -Path $tempDir | Out-Null

# Exclude .venv, outputs, git, pycache, and heavy models from the package
& robocopy ./ $tempDir /e /xd .venv output Output data Data _export_temp .git __pycache__ node_modules /xf .git* *.pyc kokoro-v1.0.onnx voices-v1.0.bin /nc /nfl /ndl /njh /njs /is

Compress-Archive -Path $tempDir -DestinationPath "$destDir/$zipName" -Force
Remove-Item -Recurse -Force $tempParent

Write-Host "============================================"
Write-Host "Done! Package created: $destDir/$zipName"
Write-Host "============================================"
