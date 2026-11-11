[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SubscriptionId,
    [Parameter(Mandatory)][string]$TenantId,
    [Parameter(Mandatory)][string]$EnvironmentName,
    [Parameter(Mandatory)][string]$Location,
    [Parameter(Mandatory)][string]$ResourceGroupName,
    [Parameter(Mandatory)][string]$EntraApplicationClientId,
    [switch]$EnablePrivateNetworking,
    [switch]$ConfirmDeployment
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot

function Invoke-AzChecked {
    param([string[]]$Arguments, [string]$Step)
    Write-Host "`n== $Step ==" -ForegroundColor Cyan
    & az @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Step failed. Review the Azure CLI output and correct the reported issue before retrying." }
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw 'Azure CLI is required. Install it from https://aka.ms/installazurecliwindows.' }
$version = (& az version --query '"azure-cli"' -o tsv)
if ($LASTEXITCODE -ne 0) { throw 'Could not read the Azure CLI version.' }
Write-Host "Azure CLI: $version"
$account = (& az account show --query '{tenant:tenantId,id:id,name:name}' -o json | ConvertFrom-Json)
if ($LASTEXITCODE -ne 0) { throw 'Run az login before continuing.' }
if ($account.tenant -ne $TenantId) { throw "Active tenant '$($account.tenant)' does not match requested tenant '$TenantId'. Run az login --tenant $TenantId." }
Invoke-AzChecked -Arguments @('account', 'set', '--subscription', $SubscriptionId) -Step 'Selecting subscription'
$selected = (& az account show --query '{id:id,name:name,tenant:tenantId}' -o json | ConvertFrom-Json)
if ($selected.id -ne $SubscriptionId -or $selected.tenant -ne $TenantId) { throw 'The selected Azure subscription or tenant could not be verified.' }
Write-Host "Verified subscription $($selected.name) ($($selected.id)) in tenant $($selected.tenant)."

$template = Join-Path $repo 'infra\main.bicep'
$deploymentName = "mfib-docproc-$EnvironmentName-$(Get-Date -Format yyyyMMddHHmmss)"
Invoke-AzChecked -Arguments @('group', 'create', '--name', $ResourceGroupName, '--location', $Location, '--output', 'none') -Step 'Creating or verifying resource group'
$common = @(
    '--resource-group', $ResourceGroupName, '--name', $deploymentName,
    '--template-file', $template,
    '--parameters', "environmentName=$EnvironmentName", "location=$Location",
    "tenantId=$TenantId", "entraApplicationClientId=$EntraApplicationClientId",
    "enablePrivateNetworking=$($EnablePrivateNetworking.IsPresent.ToString().ToLowerInvariant())"
)
Invoke-AzChecked -Arguments (@('deployment', 'group', 'validate') + $common) -Step 'Validating Bicep deployment'
Invoke-AzChecked -Arguments (@('deployment', 'group', 'what-if') + $common) -Step 'Reviewing deployment what-if'

if (-not $ConfirmDeployment) {
    Write-Host "`nNo billable resources were deployed. Review the what-if output, then rerun with -ConfirmDeployment to provision." -ForegroundColor Yellow
    return
}

Invoke-AzChecked -Arguments (@('deployment', 'group', 'create') + $common) -Step 'Deploying Azure infrastructure'
Write-Host 'Infrastructure deployed. Entra authentication bootstrap and application/function package deployment are separate required steps; run the documented scripts and verify the portal before production use.' -ForegroundColor Yellow
