# Parse command line arguments
RUN_MIGRATION=false
for arg in "$@"; do
    case $arg in
        --migrate)
            RUN_MIGRATION=true
            ;;
    esac
done

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
MAIL_HOST="${MAIL_HOST:-smtp.gmail.com}"
MAIL_PORT="${MAIL_PORT:-465}"
MAIL_USERNAME="${MAIL_USERNAME:-null}"
MAIL_PASSWORD="${MAIL_PASSWORD:-null}"
MAIL_ENCRYPTION="${MAIL_ENCRYPTION:-null}"
MAIL_FROM_ADDRESS="${MAIL_FROM_ADDRESS:-hello@example.com}"
MAIL_FROM_NAME="${MAIL_FROM_NAME:-QA Automation Server}"

DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-3306}"
DB_USER="${DB_USER:-root}"
DB_PASSWORD="${DB_PASSWORD:-root_password}"
DB_NAME="${DB_NAME:-customily-pod-tester}"
DB_ROOT_PASSWORD="${DB_ROOT_PASSWORD:-root_password}"

# Get the current date and time in the format: build-YYYYMMDD-HHMMSS
BUILD_VERSION="build-$(date +%Y%m%d-%H%M%S)"

# Common Environment Variables setup using bash array for clean syntax
ENV_ARGS=(
    --set-env-vars="OPENAI_API_KEY=$OPENAI_API_KEY"
    --set-env-vars="DAILY_REPORT_TIME=$DAILY_REPORT_TIME"
    --set-env-vars="DAILY_REPORT_TO=$DAILY_REPORT_TO"
    --set-env-vars="DAILY_REPORT_CC=$DAILY_REPORT_CC"
    --set-env-vars="MAIL_MAILER=$MAIL_MAILER"
    --set-env-vars="MAIL_HOST=$MAIL_HOST"
    --set-env-vars="MAIL_PORT=$MAIL_PORT"
    --set-env-vars="MAIL_USERNAME=$MAIL_USERNAME"
    --set-env-vars="MAIL_PASSWORD=$MAIL_PASSWORD"
    --set-env-vars="MAIL_ENCRYPTION=$MAIL_ENCRYPTION"
    --set-env-vars="MAIL_FROM_ADDRESS=$MAIL_FROM_ADDRESS"
    --set-env-vars="MAIL_FROM_NAME=$MAIL_FROM_NAME"
    --set-env-vars="DB_HOST=$DB_HOST"
    --set-env-vars="DB_PORT=$DB_PORT"
    --set-env-vars="DB_USER=$DB_USER"
    --set-env-vars="DB_PASSWORD=$DB_PASSWORD"
    --set-env-vars="DB_NAME=$DB_NAME"
    --set-env-vars="DB_ROOT_PASSWORD=$DB_ROOT_PASSWORD"
)

if [ "$RUN_MIGRATION" = true ]; then
    echo "Configuring migration job..."
    gcloud run jobs update "${SERVICE_NAME}-migration" \
        --image asia-southeast1-docker.pkg.dev/$PROJECT_ID/backend-asia/$IMAGE_NAME \
        --region="$SERVICE_REGION" \
        --command "node" \
        --args "src/migration-auth.js" \
        "${ENV_ARGS[@]}" 2>/dev/null || \
    gcloud run jobs create "${SERVICE_NAME}-migration" \
        --image asia-southeast1-docker.pkg.dev/$PROJECT_ID/backend-asia/$IMAGE_NAME \
        --region="$SERVICE_REGION" \
        --command "node" \
        --args "src/migration-auth.js" \
        "${ENV_ARGS[@]}"

    echo "Executing migration job..."
    gcloud run jobs execute "${SERVICE_NAME}-migration" \
        --region="$SERVICE_REGION" \
        --wait
else
    echo "Skipping migration job. Use --migrate to run DB migration."
fi

echo "Deploying Cloud Run service..."
gcloud run deploy "$SERVICE_NAME" \
    --image asia-southeast1-docker.pkg.dev/$PROJECT_ID/backend-asia/$IMAGE_NAME \
    --platform managed \
    --region="$SERVICE_REGION" \
    "${ENV_ARGS[@]}" \
    --allow-unauthenticated