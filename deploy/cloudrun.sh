IMAGE_NAME="customily-pod-tester"
PROJECT_ID="printerval"

#gcloud builds submit --tag gcr.io/printerval/meear-sku-image
#gcloud run deploy --source . thumbor-container --region='us-west1'

echo "Building image $IMAGE_NAME"
gcloud builds submit --tag asia-southeast1-docker.pkg.dev/$PROJECT_ID/backend-asia/$IMAGE_NAME --project=$PROJECT_ID

echo "Deploying image $IMAGE_NAME"


## gcp cloud run service name and region
SERVICE_NAME="customily-pod-tester"
SERVICE_REGION="asia-southeast1"

# Environment variables (from Jenkins params or defaults)
OPENAI_API_KEY="${OPENAI_API_KEY:-}"
DAILY_REPORT_TIME="${DAILY_REPORT_TIME:-23:50}"
DAILY_REPORT_TO="${DAILY_REPORT_TO:-admin@example.com}"
DAILY_REPORT_CC="${DAILY_REPORT_CC:-dev@example.com}"
MAIL_MAILER="${MAIL_MAILER:-smtp}"
MAIL_HOST="${MAIL_HOST:-mailpit}"
MAIL_PORT="${MAIL_PORT:-1025}"
MAIL_USERNAME="${MAIL_USERNAME:-null}"
MAIL_PASSWORD="${MAIL_PASSWORD:-null}"
MAIL_ENCRYPTION="${MAIL_ENCRYPTION:-null}"
MAIL_FROM_ADDRESS="${MAIL_FROM_ADDRESS:-hello@example.com}"
MAIL_FROM_NAME="${MAIL_FROM_NAME:-QA Automation Server}"

# Get the current date and time in the format: build-YYYYMMDD-HHMMSS
BUILD_VERSION="build-$(date +%Y%m%d-%H%M%S)"

gcloud run deploy "$SERVICE_NAME" \
    --image asia-southeast1-docker.pkg.dev/$PROJECT_ID/backend-asia/$IMAGE_NAME \
    --platform managed \
    --region="$SERVICE_REGION" \
    --set-env-vars OPENAI_API_KEY="$OPENAI_API_KEY" \
    --set-env-vars DAILY_REPORT_TIME="$DAILY_REPORT_TIME" \
    --set-env-vars DAILY_REPORT_TO="$DAILY_REPORT_TO" \
    --set-env-vars DAILY_REPORT_CC="$DAILY_REPORT_CC" \
    --set-env-vars MAIL_MAILER="$MAIL_MAILER" \
    --set-env-vars MAIL_HOST="$MAIL_HOST" \
    --set-env-vars MAIL_PORT="$MAIL_PORT" \
    --set-env-vars MAIL_USERNAME="$MAIL_USERNAME" \
    --set-env-vars MAIL_PASSWORD="$MAIL_PASSWORD" \
    --set-env-vars MAIL_ENCRYPTION="$MAIL_ENCRYPTION" \
    --set-env-vars MAIL_FROM_ADDRESS="$MAIL_FROM_ADDRESS" \
    --set-env-vars MAIL_FROM_NAME="$MAIL_FROM_NAME" \
    --allow-unauthenticated