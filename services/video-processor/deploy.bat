@echo off
REM Video Processor Service Deployment Script for Windows
REM Usage: deploy.bat [project-id] [region]

setlocal enabledelayedexpansion

set PROJECT_ID=%1
set REGION=%2

if "%PROJECT_ID%"=="" (
    for /f "tokens=*" %%i in ('gcloud config get-value project 2^>nul') do set PROJECT_ID=%%i
)
if "%REGION%"=="" set REGION=us-central1

echo ============================================
echo Video Processor Service Deployment
echo ============================================
echo Project: %PROJECT_ID%
echo Region: %REGION%
echo ============================================

if "%PROJECT_ID%"=="" (
    echo Error: No project ID specified
    echo Usage: deploy.bat project-id [region]
    exit /b 1
)

echo.
echo Enabling required APIs...
gcloud services enable cloudbuild.googleapis.com run.googleapis.com containerregistry.googleapis.com --project=%PROJECT_ID%

echo.
echo Deploying to Cloud Run (this may take 5-10 minutes)...
gcloud run deploy video-processor ^
    --source . ^
    --region %REGION% ^
    --project %PROJECT_ID% ^
    --memory 4Gi ^
    --cpu 2 ^
    --timeout 900 ^
    --concurrency 1 ^
    --min-instances 0 ^
    --max-instances 10 ^
    --set-env-vars "BUCKET_NAME=%PROJECT_ID%.appspot.com,NODE_ENV=production" ^
    --allow-unauthenticated

echo.
echo ============================================
echo Deployment Complete!
echo ============================================
echo.
echo Getting service URL...
for /f "tokens=*" %%i in ('gcloud run services describe video-processor --region %REGION% --project %PROJECT_ID% --format "value(status.url)"') do set SERVICE_URL=%%i

echo Service URL: %SERVICE_URL%
echo.
echo Next step - Configure Firebase Functions:
echo   firebase functions:config:set videoprocessor.url="%SERVICE_URL%"
echo   firebase deploy --only functions
echo.
echo ============================================

endlocal
