using '../main.bicep'

// Supply tenantId and entraApplicationClientId after verifying the selected MFIB tenant.
param environmentName = 'prod'
param location = 'westeurope'
param resourcePrefix = 'mfibdocproc'
param tenantId = '<resolve-from-verified-azure-login>'
param entraApplicationClientId = '<created-by-setup-entra.ps1>'
param allowedUsersGroupObjectId = ''
param appDisplayName = 'Document Processor'
param organizationName = 'Ministerul Fericirii și Ideilor Bune'
param brandingMode = 'mfib'
param documentRetentionDays = 90
param archiveRetentionHours = 24
param maxUploadSizeMB = 100
param maxBatchDocuments = 100
param enablePrivateNetworking = false
param enableMalwareScanning = false
