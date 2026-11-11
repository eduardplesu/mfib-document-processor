using '../main.bicep'

param environmentName = 'dev'
param location = 'westeurope'
param resourcePrefix = 'docproc'
param tenantId = '<your-tenant-id>'
param entraApplicationClientId = '<your-app-client-id>'
param allowedUsersGroupObjectId = ''
param appDisplayName = 'Document Processor'
param organizationName = 'Your Organization'
param brandingMode = 'custom'
param documentRetentionDays = 90
param archiveRetentionHours = 24
param maxUploadSizeMB = 100
param maxBatchDocuments = 100
param enablePrivateNetworking = false
param enableMalwareScanning = false
