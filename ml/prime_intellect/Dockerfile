FROM pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY ml/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt catboost

COPY ml /opt/numerai/ml
WORKDIR /opt/numerai/ml

ENV PYTHONUNBUFFERED=1 \
    NUMERAI_TORCH_DEVICE=cuda

ENTRYPOINT ["python", "prime_intellect/worker.py"]
