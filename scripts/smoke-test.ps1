[CmdletBinding()]
param([Parameter(Mandatory)][uri]$PortalUrl)

$ErrorActionPreference = 'Stop'
$healthUri = [uri]::new($PortalUrl, '/api/health')
try {
    $response = Invoke-WebRequest -Uri $healthUri -Method Get -MaximumRedirection 0
    if ($response.StatusCode -ne 200) { throw "Health endpoint returned $($response.StatusCode)." }
    Write-Host "Application health check passed: $healthUri"
} catch {
    if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -in 301, 302, 307, 308) {
        Write-Warning 'The portal redirected to authentication. This confirms the auth gate, but an authenticated health check is still required.'
        return
    }
    throw "Application health check failed: $($_.Exception.Message)"
}
