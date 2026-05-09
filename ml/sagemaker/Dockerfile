FROM python:3.11-slim

RUN pip install --no-cache-dir \
    lightgbm pandas numpy scipy scikit-learn pyarrow \
    numerapi boto3 pyyaml pydantic pydantic-settings

COPY . /opt/ml/code
WORKDIR /opt/ml/code

ENV PYTHONUNBUFFERED=1

ENTRYPOINT ["python", "sagemaker/train_entry.py"]
