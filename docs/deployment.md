# Deployment

## Prerequisites

- Azure CLI/Bicep, PowerShell 7, Node.js 24, and a verified tenant/subscription.
- Azure permissions to create the resources and assign built-in data roles.
- Entra administrator for app roles, consent, and the App Service managed-identity federated credential.

## Local Bicep checks

```powershell
az bicep build --file .\infra\main.bicep
az bicep build-params .\infra\parameters\example.bicepparam
```

## Infrastructure

```powershell
az login --tenant <tenant-id>
az account set --subscription <subscription-id>
$clientId = az ad app create --display-name "Document Processor" --sign-in-audience AzureADMyOrg --enable-id-token-issuance true --query appId -o tsv
.\scripts\deploy.ps1 -SubscriptionId <subscription-id> -TenantId <tenant-id> -EnvironmentName prod -Location westeurope -ResourceGroupName rg-document-processor -EntraApplicationClientId $clientId
```

The script validates the active tenant/subscription, runs validation and `what-if`, and stops without provisioning unless `-ConfirmDeployment` is specified. Review all resource SKUs, regional availability, permissions, and costs before confirming. The portal plan requests asynchronous scaling so Azure can continue allocating its S1 worker when regional capacity is temporarily constrained.

After provisioning, configure the redirect URI, roles, delegated Microsoft Graph `User.Read` permission, and managed-identity federated credential using the deployment outputs `portalUrl` and `authManagedIdentityPrincipalId`:

```powershell
.\scripts\setup-entra.ps1 -TenantId <tenant-id> -AppDisplayName "Document Processor" -ExistingClientId $clientId -PortalUrl <portal-url> -AuthManagedIdentityPrincipalId <auth-managed-identity-principal-id>
```

App Service Authentication is configured to fail closed. An administrator must also grant any required consent and assign users/groups the `Processor.User` or `Processor.Admin` app role. The portal uses delegated `User.Read` to display the signed-in user's name; existing sessions must sign in again after the permission is added. No client secret is needed.

## GitHub deployment

Configure an Azure federated identity credential for the repository and the `production` GitHub environment. Add `AZURE_CLIENT_ID` and `AZURE_SUBSCRIPTION_ID` repository/environment secrets, protect the `production` environment with required reviewers, and manually dispatch `.github/workflows/deploy.yml`. Give the deployment identity Storage Blob Data Contributor access to the private `function-packages` container. The workflow runs infrastructure what-if and deployment, publishes the portal, uploads the Functions package to that container, restarts the Function App, and synchronizes its triggers.

No Azure deployment is run automatically from a clone or local build.
