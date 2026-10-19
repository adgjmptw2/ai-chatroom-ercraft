$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Drawing
$inputBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$inputStream = [IO.MemoryStream]::new($inputBytes, $false)
$picture = $null
$bitmap = $null
$graphics = $null
$outputStream = $null
$parameters = $null
try {
    $picture = [Drawing.Image]::FromStream($inputStream, $true, $true)
    if ($picture.Width -gt 4096 -or $picture.Height -gt 4096 -or ([long]$picture.Width * $picture.Height) -gt 16777216) { throw 'Image too large' }
    $scale = [Math]::Min(1.0, 720.0 / [Math]::Max($picture.Width, $picture.Height))
    $width = [Math]::Max(1, [int][Math]::Round($picture.Width * $scale))
    $height = [Math]::Max(1, [int][Math]::Round($picture.Height * $scale))
    $bitmap = [Drawing.Bitmap]::new($width, $height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([Drawing.Color]::White)
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($picture, 0, 0, $width, $height)
    $codec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $parameters = [Drawing.Imaging.EncoderParameters]::new(1)
    $parameters.Param[0] = [Drawing.Imaging.EncoderParameter]::new([Drawing.Imaging.Encoder]::Quality, [long]82)
    $outputStream = [IO.MemoryStream]::new()
    $bitmap.Save($outputStream, $codec, $parameters)
    $result = $outputStream.ToArray()
    [Console]::OpenStandardOutput().Write($result, 0, $result.Length)
} finally {
    if ($parameters) { $parameters.Dispose() }
    if ($outputStream) { $outputStream.Dispose() }
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
    if ($picture) { $picture.Dispose() }
    $inputStream.Dispose()
}
