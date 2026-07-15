# Prime Intellect worker

This image is the default worker behind one-click Prime training. Build the image from the repository root, publish it, then create one public Prime custom template whose container uses the image and its normal entrypoint:

```sh
docker build --platform linux/amd64 -f ml/prime_intellect/Dockerfile -t <registry>/numerai-dashboard-prime:latest .
docker push <registry>/numerai-dashboard-prime:latest
```

Set the resulting public template ID as the Amplify environment variable `PRIME_DEFAULT_TEMPLATE_ID`. Users then only add their Prime API key and choose a live GPU offer. A user-specific template ID in provider settings overrides the managed template.

The worker reads `NUMERAI_RUN_CONFIG_JSON`, emits dashboard completion/failure markers, and supports optional presigned artifact upload through `NUMERAI_ARTIFACT_UPLOAD_URL` plus `NUMERAI_ARTIFACT_URI`.
