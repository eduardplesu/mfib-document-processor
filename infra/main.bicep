targetScope = 'resourceGroup'

@description('Short environment label, such as dev, test, or prod.')
@minLength(2)
@maxLength(8)
param environmentName string = 'prod'

@description('Azure region for all deployed resources (for example westeurope, swedencentral, or francecentral).')
param location string = resourceGroup().location

@description('Short alphanumeric prefix used for resource naming.')
@minLength(3)
@maxLength(12)
param resourcePrefix string = 'mfibdocproc'

@description('Microsoft Entra ID tenant GUID. Defaults to the current subscription tenant.')
param tenantId string = subscription().tenantId

@description('Application (client) ID of the single-tenant Microsoft Entra ID app registration.')
param entraApplicationClientId string

@description('Optional Microsoft Entra security group Object ID for restricting access.')
param allowedUsersGroupObjectId string = ''

@description('Application title displayed in the portal header.')
param appDisplayName string = 'Document Processor'

@description('Organization name displayed in branding and alt text.')
param organizationName string = 'Ministerul Fericirii și Ideilor Bune'

@description('Branding preset (custom or mfib).')
@allowed([
  'custom'
  'mfib'
])
param brandingMode string = 'custom'

@description('Retention period in days for uploaded and processed documents.')
@minValue(1)
@maxValue(3650)
param documentRetentionDays int = 90

@description('Retention period in hours for generated ZIP archives.')
@minValue(1)
@maxValue(168)
param archiveRetentionHours int = 24

@description('Maximum allowed size in MB per uploaded document.')
@minValue(1)
@maxValue(500)
param maxUploadSizeMB int = 100

@description('Maximum number of documents allowed per batch upload.')
@minValue(1)
@maxValue(1000)
param maxBatchDocuments int = 100

@description('Deploy VNet integration, Private Endpoints, and Private DNS zones for Storage and Document Intelligence.')
param enablePrivateNetworking bool = false

@description('Flag reserved for Microsoft Defender for Storage malware scanning.')
param enableMalwareScanning bool = false

var suffix = uniqueString(subscription().id, resourceGroup().id, environmentName)
var baseName = '${resourcePrefix}${environmentName}'
var storageName = 'mfib${suffix}'
var appName = take('${baseName}-${suffix}', 60)
var functionName = take('${baseName}-fn-${suffix}', 60)
var planName = take('${baseName}-plan-${suffix}', 40)
var functionPlanName = take('${baseName}-fplan-${suffix}', 40)
var workspaceName = '${baseName}-law-${suffix}'
var insightsName = '${baseName}-appi-${suffix}'
var diName = take('${baseName}-di-${suffix}', 64)
var blobEndpoint = 'https://${storageName}.blob.${environment().suffixes.storage}'

resource workspace 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: workspaceName
  location: location
  properties: { sku: { name: 'PerGB2018' }, retentionInDays: 30, features: { enableLogAccessUsingOnlyResourcePermissions: true } }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: insightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    DisableLocalAuth: true
  }
}

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    publicNetworkAccess: enablePrivateNetworking ? 'Disabled' : 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: enablePrivateNetworking ? 'Deny' : 'Allow'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          enabled: true
          name: 'expire-document-data'
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: [ 'blockBlob' ], prefixMatch: [ 'incoming/', 'results/', 'outputs/' ] }
            actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: documentRetentionDays } } }
          }
        }
        {
          enabled: true
          name: 'expire-staging-uploads'
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: [ 'blockBlob' ], prefixMatch: [ 'staging/' ] }
            actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 2 } } }
          }
        }
      ]
    }
  }
}

resource network 'Microsoft.Network/virtualNetworks@2023-09-01' = if (enablePrivateNetworking) {
  name: '${baseName}-vnet-${suffix}'
  location: location
  properties: {
    addressSpace: { addressPrefixes: [ '10.24.0.0/16' ] }
    subnets: []
  }
}

resource integrationSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = if (enablePrivateNetworking) {
  parent: network
  name: 'app-integration'
  properties: {
    addressPrefix: '10.24.0.0/26'
    delegations: [
      { name: 'web-farms', properties: { serviceName: 'Microsoft.Web/serverFarms' } }
    ]
  }
}

resource privateEndpointSubnet 'Microsoft.Network/virtualNetworks/subnets@2023-09-01' = if (enablePrivateNetworking) {
  parent: network
  name: 'private-endpoints'
  properties: {
    addressPrefix: '10.24.0.64/26'
    privateEndpointNetworkPolicies: 'Disabled'
  }
}

resource blobDns 'Microsoft.Network/privateDnsZones@2020-06-01' = if (enablePrivateNetworking) {
  name: 'privatelink.blob.${environment().suffixes.storage}'
  location: 'global'
}
resource tableDns 'Microsoft.Network/privateDnsZones@2020-06-01' = if (enablePrivateNetworking) {
  name: 'privatelink.table.${environment().suffixes.storage}'
  location: 'global'
}
resource queueDns 'Microsoft.Network/privateDnsZones@2020-06-01' = if (enablePrivateNetworking) {
  name: 'privatelink.queue.${environment().suffixes.storage}'
  location: 'global'
}
resource cognitiveDns 'Microsoft.Network/privateDnsZones@2020-06-01' = if (enablePrivateNetworking) {
  name: 'privatelink.cognitiveservices.azure.com'
  location: 'global'
}

resource blobDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (enablePrivateNetworking) {
  parent: blobDns
  name: 'storage-link'
  location: 'global'
  properties: { virtualNetwork: { id: network.id }, registrationEnabled: false }
}
resource tableDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (enablePrivateNetworking) {
  parent: tableDns
  name: 'storage-link'
  location: 'global'
  properties: { virtualNetwork: { id: network.id }, registrationEnabled: false }
}
resource queueDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (enablePrivateNetworking) {
  parent: queueDns
  name: 'storage-link'
  location: 'global'
  properties: { virtualNetwork: { id: network.id }, registrationEnabled: false }
}
resource cognitiveDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = if (enablePrivateNetworking) {
  parent: cognitiveDns
  name: 'cognitive-link'
  location: 'global'
  properties: { virtualNetwork: { id: network.id }, registrationEnabled: false }
}

resource blobPrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (enablePrivateNetworking) {
  name: '${baseName}-blob-pe-${suffix}'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnet.id }
    privateLinkServiceConnections: [
      { name: 'storage-blob', properties: { privateLinkServiceId: storage.id, groupIds: [ 'blob' ] } }
    ]
  }
}
resource tablePrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (enablePrivateNetworking) {
  name: '${baseName}-table-pe-${suffix}'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnet.id }
    privateLinkServiceConnections: [
      { name: 'storage-table', properties: { privateLinkServiceId: storage.id, groupIds: [ 'table' ] } }
    ]
  }
}
resource queuePrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (enablePrivateNetworking) {
  name: '${baseName}-queue-pe-${suffix}'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnet.id }
    privateLinkServiceConnections: [
      { name: 'storage-queue', properties: { privateLinkServiceId: storage.id, groupIds: [ 'queue' ] } }
    ]
  }
}
resource cognitivePrivateEndpoint 'Microsoft.Network/privateEndpoints@2023-09-01' = if (enablePrivateNetworking) {
  name: '${baseName}-di-pe-${suffix}'
  location: location
  properties: {
    subnet: { id: privateEndpointSubnet.id }
    privateLinkServiceConnections: [
      { name: 'document-intelligence', properties: { privateLinkServiceId: documentIntelligence.id, groupIds: [ 'account' ] } }
    ]
  }
}
resource blobPrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = if (enablePrivateNetworking) {
  parent: blobPrivateEndpoint
  name: 'default'
  properties: { privateDnsZoneConfigs: [ { name: 'blob', properties: { privateDnsZoneId: blobDns.id } } ] }
}
resource tablePrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = if (enablePrivateNetworking) {
  parent: tablePrivateEndpoint
  name: 'default'
  properties: { privateDnsZoneConfigs: [ { name: 'table', properties: { privateDnsZoneId: tableDns.id } } ] }
}
resource queuePrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = if (enablePrivateNetworking) {
  parent: queuePrivateEndpoint
  name: 'default'
  properties: { privateDnsZoneConfigs: [ { name: 'queue', properties: { privateDnsZoneId: queueDns.id } } ] }
}
resource cognitivePrivateDnsGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2023-09-01' = if (enablePrivateNetworking) {
  parent: cognitivePrivateEndpoint
  name: 'default'
  properties: { privateDnsZoneConfigs: [ { name: 'cognitive', properties: { privateDnsZoneId: cognitiveDns.id } } ] }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    cors: {
      corsRules: [
        {
          allowedOrigins: [ 'https://${appName}.azurewebsites.net' ]
          allowedMethods: [ 'PUT', 'OPTIONS', 'HEAD' ]
          allowedHeaders: [ 'x-ms-blob-type', 'content-type', 'x-ms-version', 'x-ms-date', 'x-ms-client-request-id' ]
          exposedHeaders: [ 'etag', 'x-ms-request-id' ]
          maxAgeInSeconds: 1800
        }
      ]
    }
  }
}

resource incoming 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'incoming'
  properties: { publicAccess: 'None' }
}
resource staging 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'staging'
  properties: { publicAccess: 'None' }
}
resource results 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'results'
  properties: { publicAccess: 'None' }
}
resource outputs 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'outputs'
  properties: { publicAccess: 'None' }
}
resource functionPackages 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'function-packages'
  properties: { publicAccess: 'None' }
}
resource queueService 'Microsoft.Storage/storageAccounts/queueServices@2023-05-01' = {
  parent: storage
  name: 'default'
}
resource documentQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'document-jobs'
}
resource archiveQueue 'Microsoft.Storage/storageAccounts/queueServices/queues@2023-05-01' = {
  parent: queueService
  name: 'archive-jobs'
}
resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storage
  name: 'default'
}
resource jobsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'Jobs'
}
resource documentsTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'Documents'
}
resource archivesTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'Archives'
}

resource documentIntelligence 'Microsoft.CognitiveServices/accounts@2023-05-01' = {
  name: diName
  location: location
  kind: 'FormRecognizer'
  sku: { name: 'S0' }
  identity: { type: 'SystemAssigned' }
  properties: {
    customSubDomainName: diName
    publicNetworkAccess: enablePrivateNetworking ? 'Disabled' : 'Enabled'
    disableLocalAuth: true
  }
}

resource appPlan 'Microsoft.Web/serverfarms@2024-11-01' = {
  name: planName
  location: location
  kind: 'linux'
  sku: { name: 'S1', tier: 'Standard', size: 'S1', capacity: 1 }
  properties: { reserved: true, asyncScalingEnabled: true }
}

resource authIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${baseName}-auth-${suffix}'
  location: location
}

resource app 'Microsoft.Web/sites@2022-03-01' = {
  name: appName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned, UserAssigned'
    userAssignedIdentities: {
      '${authIdentity.id}': {}
    }
  }
  properties: {
    serverFarmId: appPlan.id
    httpsOnly: true
    virtualNetworkSubnetId: enablePrivateNetworking ? integrationSubnet.id : null
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      appCommandLine: 'node server.js'
      alwaysOn: true
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      http20Enabled: true
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'HOSTNAME', value: '0.0.0.0' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '1' }
        { name: 'AZURE_STORAGE_ACCOUNT_URL', value: blobEndpoint }
        { name: 'AZURE_STORAGE_ACCOUNT_NAME', value: storageName }
        { name: 'DOCUMENTS_CONTAINER', value: 'incoming' }
        { name: 'UPLOADS_CONTAINER', value: 'staging' }
        { name: 'RESULTS_CONTAINER', value: 'results' }
        { name: 'OUTPUTS_CONTAINER', value: 'outputs' }
        { name: 'JOBS_TABLE', value: 'Jobs' }
        { name: 'DOCUMENTS_TABLE', value: 'Documents' }
        { name: 'QUEUE_NAME', value: 'document-jobs' }
        { name: 'ARCHIVE_QUEUE_NAME', value: 'archive-jobs' }
        { name: 'ARCHIVES_TABLE', value: 'Archives' }
        { name: 'DOCUMENT_INTELLIGENCE_ENDPOINT', value: documentIntelligence.properties.endpoint }
        { name: 'DOCUMENT_INTELLIGENCE_API_VERSION', value: '2024-11-30' }
        { name: 'DOCUMENT_INTELLIGENCE_MODEL_ID', value: 'prebuilt-layout' }
        { name: 'TENANT_ID', value: tenantId }
        { name: 'ENTRA_APPLICATION_CLIENT_ID', value: entraApplicationClientId }
        { name: 'OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID', value: authIdentity.properties.clientId }
        { name: 'ALLOWED_USERS_GROUP_OBJECT_ID', value: allowedUsersGroupObjectId }
        { name: 'APP_DISPLAY_NAME', value: appDisplayName }
        { name: 'ORGANIZATION_NAME', value: organizationName }
        { name: 'BRANDING_MODE', value: brandingMode }
        { name: 'BRANDING_LOGO_PATH', value: '/branding/ministry-logo.jpeg' }
        { name: 'MAX_UPLOAD_SIZE_MB', value: string(maxUploadSizeMB) }
        { name: 'MAX_BATCH_DOCUMENTS', value: string(maxBatchDocuments) }
        { name: 'ARCHIVE_RETENTION_HOURS', value: string(archiveRetentionHours) }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
      ]
    }
  }
}

resource appAuth 'Microsoft.Web/sites/config@2022-03-01' = {
  parent: app
  name: 'authsettingsV2'
  properties: {
    platform: { enabled: true, runtimeVersion: '~1' }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'Return401'
      excludedPaths: [
        '/'
        '/api/health'
        '/favicon.ico'
        '/branding/ministry-logo.jpeg'
        '/branding/minister-logo-light.jpeg'
        '/branding/*'
        '/_next/*'
        '/_next/static/*'
        '/_next/static/css/*'
        '/_next/static/chunks/*'
        '/_next/static/chunks/app/*'
        '/_next/static/media/*'
      ]
    }
    httpSettings: { requireHttps: true }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: entraApplicationClientId
          openIdIssuer: uri(environment().authentication.loginEndpoint, '${tenantId}/v2.0')
          clientSecretSettingName: 'OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID'
        }
        validation: { allowedAudiences: [ entraApplicationClientId ] }
        login: { loginParameters: [ 'response_type=code id_token', 'scope=openid profile email offline_access https://graph.microsoft.com/User.Read' ] }
      }
    }
    login: {
      routes: { logoutEndpoint: '/.auth/logout' }
      tokenStore: { enabled: true }
    }
  }
}

resource appSlotConfig 'Microsoft.Web/sites/config@2022-03-01' = {
  parent: app
  name: 'slotConfigNames'
  properties: { appSettingNames: [ 'OVERRIDE_USE_MI_FIC_ASSERTION_CLIENTID' ] }
}

resource functionPlan 'Microsoft.Web/serverfarms@2022-03-01' = {
  name: functionPlanName
  location: location
  kind: enablePrivateNetworking ? 'elastic' : 'functionapp'
  sku: enablePrivateNetworking
    ? { name: 'EP1', tier: 'ElasticPremium', size: 'EP1', capacity: 1 }
    : { name: 'Y1', tier: 'Dynamic', size: 'Y1', family: 'Y' }
  properties: enablePrivateNetworking
    ? { reserved: true, maximumElasticWorkerCount: 20 }
    : { reserved: false }
}

resource functionApp 'Microsoft.Web/sites@2022-03-01' = {
  name: functionName
  location: location
  kind: enablePrivateNetworking ? 'functionapp,linux' : 'functionapp'
  identity: { type: 'SystemAssigned' }
  properties: {
    reserved: enablePrivateNetworking
    serverFarmId: functionPlan.id
    httpsOnly: true
    virtualNetworkSubnetId: enablePrivateNetworking ? integrationSubnet.id : null
    siteConfig: {
      linuxFxVersion: enablePrivateNetworking ? 'NODE|24' : null
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        { name: 'FUNCTIONS_EXTENSION_VERSION', value: '~4' }
        { name: 'FUNCTIONS_WORKER_RUNTIME', value: 'node' }
        { name: 'WEBSITE_NODE_DEFAULT_VERSION', value: '~22' }
        { name: 'FUNCTIONS_NODE_BLOCK_ON_ENTRY_POINT_ERROR', value: 'true' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE', value: '${blobEndpoint}/function-packages/functions.zip' }
        { name: 'WEBSITE_RUN_FROM_PACKAGE_BLOB_MI_RESOURCE_ID', value: 'SystemAssigned' }
        { name: 'AzureWebJobsStorage__accountName', value: storageName }
        { name: 'AzureWebJobsStorage__credential', value: 'managedidentity' }
        { name: 'AZURE_STORAGE_ACCOUNT_URL', value: blobEndpoint }
        { name: 'DOCUMENTS_CONTAINER', value: 'incoming' }
        { name: 'UPLOADS_CONTAINER', value: 'staging' }
        { name: 'RESULTS_CONTAINER', value: 'results' }
        { name: 'OUTPUTS_CONTAINER', value: 'outputs' }
        { name: 'QUEUE_NAME', value: 'document-jobs' }
        { name: 'ARCHIVE_QUEUE_NAME', value: 'archive-jobs' }
        { name: 'ARCHIVES_TABLE', value: 'Archives' }
        { name: 'DOCUMENT_INTELLIGENCE_ENDPOINT', value: documentIntelligence.properties.endpoint }
        { name: 'DOCUMENT_INTELLIGENCE_API_VERSION', value: '2024-11-30' }
        { name: 'DOCUMENT_INTELLIGENCE_MODEL_ID', value: 'prebuilt-layout' }
        { name: 'ARCHIVE_RETENTION_HOURS', value: string(archiveRetentionHours) }
        { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insights.properties.ConnectionString }
        { name: 'APPLICATIONINSIGHTS_AUTHENTICATION_STRING', value: 'Authorization=AAD' }
      ]
    }
  }
}

var blobContributorRole = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var queueContributorRole = '974c5e8b-45b9-4653-ba55-5f855dd0fb88'
var tableContributorRole = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'
var cognitiveUserRole = 'a97b65f3-24c7-4388-baec-2e87135dc908'
var blobDelegatorRole = 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'
var blobOwnerRole = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var blobReaderRole = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var monitoringPublisherRole = '3913510d-42f4-4e42-8a64-420c390055eb'

resource appBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, app.id, blobContributorRole)
  scope: storage
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributorRole), principalId: app.identity.principalId, principalType: 'ServicePrincipal' }
}
resource appBlobDelegatorRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, app.id, blobDelegatorRole)
  scope: storage
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobDelegatorRole), principalId: app.identity.principalId, principalType: 'ServicePrincipal' }
}
resource functionBlobOwnerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, blobOwnerRole)
  scope: storage
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobOwnerRole), principalId: functionApp.identity.principalId, principalType: 'ServicePrincipal' }
}
resource appQueueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, app.id, queueContributorRole)
  scope: storage
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueContributorRole), principalId: app.identity.principalId, principalType: 'ServicePrincipal' }
}
resource functionQueueRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, queueContributorRole)
  scope: storage
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', queueContributorRole), principalId: functionApp.identity.principalId, principalType: 'ServicePrincipal' }
}
resource appTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, app.id, tableContributorRole)
  scope: storage
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableContributorRole), principalId: app.identity.principalId, principalType: 'ServicePrincipal' }
}
resource functionTableRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, functionApp.id, tableContributorRole)
  scope: storage
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', tableContributorRole), principalId: functionApp.identity.principalId, principalType: 'ServicePrincipal' }
}
resource appDiRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(documentIntelligence.id, app.id, cognitiveUserRole)
  scope: documentIntelligence
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveUserRole), principalId: app.identity.principalId, principalType: 'ServicePrincipal' }
}
resource functionDiRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(documentIntelligence.id, functionApp.id, cognitiveUserRole)
  scope: documentIntelligence
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', cognitiveUserRole), principalId: functionApp.identity.principalId, principalType: 'ServicePrincipal' }
}
resource diSourceBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(incoming.id, documentIntelligence.id, blobReaderRole)
  scope: incoming
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobReaderRole), principalId: documentIntelligence.identity.principalId, principalType: 'ServicePrincipal' }
}
resource diResultBlobRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(results.id, documentIntelligence.id, blobContributorRole)
  scope: results
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', blobContributorRole), principalId: documentIntelligence.identity.principalId, principalType: 'ServicePrincipal' }
}
resource functionTelemetryRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(insights.id, functionApp.id, monitoringPublisherRole)
  scope: insights
  properties: { roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringPublisherRole), principalId: functionApp.identity.principalId, principalType: 'ServicePrincipal' }
}

output appName string = app.name
output functionAppName string = functionApp.name
output storageAccountName string = storage.name
output authManagedIdentityPrincipalId string = authIdentity.properties.principalId
output documentIntelligenceEndpoint string = documentIntelligence.properties.endpoint
output portalUrl string = 'https://${app.properties.defaultHostName}'
output privateNetworkingNote string = enablePrivateNetworking ? 'Private endpoints and DNS are provisioned; client VPN and target-region validation are required.' : 'Standard secure profile; Azure service endpoints are public and protected by Entra/RBAC.'
output malwareScanningNote string = enableMalwareScanning ? 'Requested but not provisioned: enable Defender for Storage after explicit cost approval.' : 'Disabled.'
