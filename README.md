# photo-gallery-app

Node.js/Express photo gallery. Uploads images to a private S3 bucket, stores descriptions
in RDS PostgreSQL, and serves images via CloudFront. Containerized and deployed to ECS
Fargate through a GitHub Actions → ECR → EventBridge → CodePipeline → CodeDeploy
(blue/green) pipeline.

```
server.js                       Express API + static frontend
public/index.html               Gallery UI (upload + grid)
Dockerfile                      Multi-stage, non-root, node:20-alpine
appspec.yaml                    CodeDeploy ECS blue/green spec
.github/workflows/build-and-deploy.yml   OIDC build/push/deploy
```

## Endpoints
- `GET /health` — ALB health check (returns 200).
- `GET /api/photos` — list photos (id, description, CloudFront URL, createdAt).
- `POST /api/photos` — multipart upload (`image` file + `description` text).

## Runtime configuration (env vars set by the ECS task definition)
`PORT`, `AWS_REGION`, `S3_BUCKET`, `CLOUDFRONT_DOMAIN`, `DB_HOST`, `DB_PORT`, `DB_NAME`,
`DB_SECRET_ARN`; `DB_USER` / `DB_PASSWORD` injected as container **secrets** from the
RDS-managed Secrets Manager secret. No credentials are baked into the image.

## CI/CD setup (GitHub repo settings)
After the infra stack is deployed, from its **Outputs** set:
- Secret `AWS_ROLE_ARN` = `GitHubActionsRoleArn`
- Variable `CONFIG_BUCKET` = `ConfigBucketName`
- (defaults already match) Variables `AWS_REGION=eu-central-1`,
  `ECR_REPOSITORY=photo-gallery`, `TASK_FAMILY=photo-gallery`

Push to `main` → the workflow uses **OIDC** (no static keys) to build the image, render
`taskdef.json` from the live CFN task definition, upload `config.zip` (taskdef + appspec)
to S3, then push the image to ECR **last** so EventBridge triggers the blue/green deploy
only after the config is in place.

## Local run (optional)
```
npm install
S3_BUCKET=... CLOUDFRONT_DOMAIN=... DB_HOST=... DB_NAME=photogallery \
DB_USER=... DB_PASSWORD=... AWS_REGION=eu-central-1 npm start
```
Requires AWS credentials with S3 access and network reachability to the DB.
