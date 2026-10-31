# coe-warmup.ps1
# Warms the three CoE seats in Ollama and checks they stay resident
# at num_ctx 8192, the same context the provider sends.

$models = @("llama3.1:8b", "mistral:7b", "qwen2.5:7b")
$tagFallback = @{
    "mistral:7b" = "mistral:latest"
}
$ollamaUrl = if ($env:OLLAMA_URL) { $env:OLLAMA_URL.TrimEnd("/") } else { "http://localhost:11434" }
$numCtx = 8192
# This machine's MX450 has about 2 GB of VRAM. Ollama predicts each 7B
# model will not fit beside another one and unloads the previous runner.
# num_gpu 0 keeps the warm runners in system RAM, where all three fit.
# A later request that omits num_gpu still reuses that runner.
$numGpu = 0
$keepAlive = "30m"
$maxRetries = 2
$retryDelaySec = 5
$postWarmDelaySec = 2

function Invoke-OllamaJson($path, $payload, $timeoutSec) {
    $json = $payload | ConvertTo-Json -Depth 6 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    return Invoke-RestMethod -Uri "$ollamaUrl$path" -Method POST -ContentType "application/json" -Body $bytes -TimeoutSec $timeoutSec
}

function Get-InstalledModels {
    $response = Invoke-RestMethod -Uri "$ollamaUrl/api/tags" -Method GET -TimeoutSec 10
    return @($response.models | ForEach-Object { $_.name })
}

function Get-ResidentModels {
    $response = Invoke-RestMethod -Uri "$ollamaUrl/api/ps" -Method GET -TimeoutSec 10
    return @($response.models)
}

function Test-OllamaRunning {
    try {
        Get-InstalledModels | Out-Null
        return $true
    } catch {
        Write-Host "Ollama is not responding at $ollamaUrl" -ForegroundColor Red
        return $false
    }
}

function Ensure-ModelTag($model) {
    $installed = Get-InstalledModels
    if ($installed -contains $model) {
        return $true
    }

    $fallback = $tagFallback[$model]
    if ($fallback -and ($installed -contains $fallback)) {
        Write-Host "$model is not installed. Tagging the local $fallback model as $model." -ForegroundColor Yellow
        & ollama cp $fallback $model
        if ($LASTEXITCODE -ne 0) {
            Write-Host "Could not tag $fallback as $model." -ForegroundColor Red
            return $false
        }
        return $true
    }

    Write-Host "$model is not installed. Pull it, or install one of: $($installed -join ', ')" -ForegroundColor Red
    return $false
}

function Warm-Model($model) {
    $body = @{
        model = $model
        prompt = "hi"
        stream = $false
        keep_alive = $keepAlive
        options = @{
            num_predict = 1
            num_ctx = $numCtx
            num_gpu = $numGpu
        }
    }

    try {
        Write-Host "Warming $model at num_ctx $numCtx..." -ForegroundColor Cyan
        Invoke-OllamaJson "/api/generate" $body 600 | Out-Null
        return $true
    } catch {
        Write-Host "Warm request failed for $model : $($_.Exception.Message)" -ForegroundColor Yellow
        return $false
    }
}

function Test-ModelLoaded($model) {
    try {
        $match = Get-ResidentModels | Where-Object { $_.name -eq $model -or $_.model -eq $model } | Select-Object -First 1
        if (-not $match) {
            return $false
        }
        if ([int]$match.context_length -ne $numCtx) {
            Write-Host "$model is resident at context $($match.context_length), not $numCtx." -ForegroundColor Yellow
            return $false
        }
        return $true
    } catch {
        Write-Host "Could not read loaded models from $ollamaUrl/api/ps" -ForegroundColor Yellow
        return $false
    }
}

if (-not (Test-OllamaRunning)) {
    Write-Host "Start Ollama first, then re-run this script." -ForegroundColor Red
    exit 1
}

$failed = @()

foreach ($model in $models) {
    if (-not (Ensure-ModelTag $model)) {
        $failed += $model
        continue
    }

    $loaded = $false
    for ($attempt = 1; $attempt -le ($maxRetries + 1); $attempt++) {
        if (Warm-Model $model) {
            Start-Sleep -Seconds $postWarmDelaySec
            if (Test-ModelLoaded $model) {
                Write-Host "Loaded: $model" -ForegroundColor Green
                $loaded = $true
                break
            }
        }
        if ($attempt -le $maxRetries) {
            Write-Host "Retry $attempt for $model in ${retryDelaySec}s..." -ForegroundColor Yellow
            Start-Sleep -Seconds $retryDelaySec
        }
    }
    if (-not $loaded) {
        Write-Host "FAILED to load: $model" -ForegroundColor Red
        $failed += $model
    }
}

$stillResident = @()
foreach ($model in $models) {
    if (($failed -notcontains $model) -and (Test-ModelLoaded $model)) {
        $stillResident += $model
    } elseif ($failed -notcontains $model) {
        Write-Host "UNLOADED after warmup: $model" -ForegroundColor Red
        $failed += $model
    }
}

Write-Host "`n--- Current ollama ps ---" -ForegroundColor Cyan
& ollama ps

if ($failed.Count -gt 0) {
    Write-Host "`nFailed models: $($failed -join ', ')" -ForegroundColor Red
    Write-Host "Resident at num_ctx ${numCtx}: $($stillResident -join ', ')" -ForegroundColor Yellow
    exit 2
}

Write-Host "`nAll three models are resident at num_ctx $numCtx." -ForegroundColor Green
exit 0
