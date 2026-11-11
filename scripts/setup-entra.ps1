[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [Parameter(Mandatory)][string]$AppDisplayName,
    [Parameter(Mandatory)][string]$PortalUrl,
    [string]$ExistingClientId,
    [string]$AuthManagedIdentityPrincipalId
)

$ErrorActionPreference = 'Stop'
if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI is required.' }
$account = (& az account show --query tenantId -o tsv)
if ($LASTEXITCODE -ne 0 -or $account -ne $TenantId) { throw "Sign in to the intended tenant first: az login --tenant $TenantId" }
if (-not $ExistingClientId) {
    $matches = @(& az ad app list --display-name $AppDisplayName --query "[?displayName=='$AppDisplayName'].appId" -o tsv)
    if ($LASTEXITCODE -ne 0) { throw 'Could not query Entra applications. Confirm the operator has Microsoft Graph application permissions.' }
    $matches = @($matches | Where-Object { $_ })
    if ($matches.Count -gt 1) { throw "Multiple applications named '$AppDisplayName' exist. Pass -ExistingClientId after an administrator identifies the correct application." }
    if ($matches.Count -eq 1) {
        $ExistingClientId = $matches[0]
        Write-Host "Reusing application $ExistingClientId."
    } else {
        $created = (& az ad app create --display-name $AppDisplayName --sign-in-audience AzureADMyOrg --web-redirect-uris "$($PortalUrl.TrimEnd('/'))/.auth/login/aad/callback" --query appId -o tsv)
        if ($LASTEXITCODE -ne 0 -or -not $created) { throw 'Application creation failed. Ask an Entra administrator to grant the required application-management permissions.' }
        $ExistingClientId = $created
        Write-Host "Created single-tenant app registration: $ExistingClientId"
    }
} else {
    Write-Host "Using administrator-supplied application client ID $ExistingClientId."
}

$appObjectId = (& az ad app show --id $ExistingClientId --query id -o tsv)
if ($LASTEXITCODE -ne 0 -or -not $appObjectId) { throw 'Could not resolve the Entra application object ID.' }
$graphAppId = '00000003-0000-0000-c000-000000000000'
$graphUserReadScopeId = 'e1fe6dd8-ba31-4d61-89e7-88639da4683d'
$permissions = @(& az ad app permission list --id $ExistingClientId --output json | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Could not read the application API permissions.' }
$graphPermissions = @($permissions | Where-Object { $_.resourceAppId -eq $graphAppId })
if (-not ($graphPermissions.resourceAccess | Where-Object { $_.id -eq $graphUserReadScopeId -and $_.type -eq 'Scope' })) {
    & az ad app permission add --id $ExistingClientId --api $graphAppId --api-permissions "$graphUserReadScopeId=Scope" --output none
    if ($LASTEXITCODE -ne 0) { throw 'Could not add the delegated Microsoft Graph User.Read permission.' }
    Write-Host 'Added delegated Microsoft Graph User.Read; user or administrator consent may be required.'
}
$graphUri = "https://graph.microsoft.com/v1.0/applications/$appObjectId"
$application = (& az rest --method GET --uri "${graphUri}?%24select=appRoles,web" | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Could not read application roles. Grant Microsoft Graph Application.ReadWrite.All and admin consent, then retry.' }
$redirectUri = "$($PortalUrl.TrimEnd('/'))/.auth/login/aad/callback"
$redirectUris = @($application.web.redirectUris | Where-Object { $_ })
if ($redirectUri -notin $redirectUris) { $redirectUris += $redirectUri }
$updateArguments = @('ad', 'app', 'update', '--id', $ExistingClientId, '--web-redirect-uris') + $redirectUris + @('--enable-id-token-issuance', 'true', '--output', 'none')
& az @updateArguments
if ($LASTEXITCODE -ne 0) { throw 'Could not update the application redirect URIs or ID token settings.' }
$roles = @($application.appRoles | ForEach-Object {
    @{
        allowedMemberTypes = @($_.allowedMemberTypes)
        description = $_.description
        displayName = $_.displayName
        id = $_.id
        isEnabled = $_.isEnabled
        value = $_.value
    }
})
$roleDefinitions = @(
    @{ id = '11700000-0000-0000-0000-000000000001'; value = 'Processor.User'; displayName = 'Processor User'; description = 'Can upload and process documents owned by the signed-in user.' },
    @{ id = '11700000-0000-0000-0000-000000000002'; value = 'Processor.Admin'; displayName = 'Processor Admin'; description = 'Can perform processor administration tasks.' }
)
$changed = $false
foreach ($definition in $roleDefinitions) {
    if (-not ($roles | Where-Object { $_.value -eq $definition.value })) {
        if ($roles | Where-Object { $_.id -eq $definition.id }) { throw "Role ID collision for $($definition.value). Resolve it in Entra before retrying." }
        $roles += @{
            allowedMemberTypes = @('User')
            description = $definition.description
            displayName = $definition.displayName
            id = $definition.id
            isEnabled = $true
            value = $definition.value
        }
        $changed = $true
    }
}
if ($changed) {
    $body = @{ appRoles = $roles } | ConvertTo-Json -Depth 8 -Compress
    $bodyPath = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($bodyPath, $body, [System.Text.UTF8Encoding]::new($false))
        & az rest --method PATCH --uri $graphUri --headers 'Content-Type=application/json' --body "@$bodyPath" --output none
        if ($LASTEXITCODE -ne 0) { throw 'Could not configure application roles. Confirm Microsoft Graph Application.ReadWrite.All and admin consent.' }
    } finally {
        Remove-Item -LiteralPath $bodyPath -Force
    }
    Write-Host 'Processor User and Processor Admin roles configured.'
} else {
    Write-Host 'Processor User and Processor Admin roles already exist.'
}
if ($AuthManagedIdentityPrincipalId) {
    $credentialName = 'app-service-auth'
    $issuer = "https://login.microsoftonline.com/$TenantId/v2.0"
    $credentials = @(& az ad app federated-credential list --id $ExistingClientId --output json | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0) { throw 'Could not list federated identity credentials.' }
    $matchingCredentials = @($credentials | Where-Object { $_.name -eq $credentialName })
    if ($matchingCredentials.Count -gt 1) { throw "Multiple federated credentials named '$credentialName' exist." }
    if ($matchingCredentials.Count -eq 1) {
        $existing = $matchingCredentials[0]
        if ($existing.issuer -ne $issuer -or $existing.subject -ne $AuthManagedIdentityPrincipalId -or
            @($existing.audiences).Count -ne 1 -or $existing.audiences[0] -ne 'api://AzureADTokenExchange') {
            throw "Federated credential '$credentialName' exists with different settings. Review it before retrying."
        }
    } else {
        $credential = @{
            name = $credentialName
            issuer = $issuer
            subject = $AuthManagedIdentityPrincipalId
            audiences = @('api://AzureADTokenExchange')
            description = 'Managed identity used by App Service Authentication.'
        } | ConvertTo-Json -Depth 4 -Compress
        $credentialPath = [System.IO.Path]::GetTempFileName()
        try {
            [System.IO.File]::WriteAllText($credentialPath, $credential, [System.Text.UTF8Encoding]::new($false))
            & az ad app federated-credential create --id $ExistingClientId --parameters $credentialPath --output none
            if ($LASTEXITCODE -ne 0) { throw 'Could not create the App Service federated identity credential.' }
        } finally {
            Remove-Item -LiteralPath $credentialPath -Force
        }
        Write-Host 'App Service managed-identity federated credential configured.'
    }
}

$spObjectId = (& az ad sp show --id $ExistingClientId --query id -o tsv 2>$null)
if (-not $spObjectId) {
    $spObjectId = (& az ad sp create --id $ExistingClientId --query id -o tsv 2>$null)
}
if ($spObjectId) {
    & az ad app permission admin-consent --id $ExistingClientId 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host 'Granted tenant-wide admin consent for Microsoft Graph User.Read (supports Member and B2B Guest users).'
    } else {
        Write-Warning 'Could not automatically grant tenant-wide admin consent. A Global/Privileged Role Administrator can grant admin consent in Entra ID so B2B Guest users can sign in without a consent prompt.'
    }
}
Write-Host ''
Write-Host "App client ID: $ExistingClientId"
Write-Host "Tenant ID:     $TenantId"
Write-Host "Redirect URI:  $($PortalUrl.TrimEnd('/'))/.auth/login/aad/callback"
Write-Host ''
Write-Warning 'Before enabling production access, confirm the managed-identity federated credential, grant any required Graph User.Read consent, and assign users/groups to the app roles. No client secret was generated or printed.'
