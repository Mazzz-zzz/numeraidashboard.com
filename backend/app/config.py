from functools import lru_cache

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # Database
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "numeraidashboard"
    db_user: str = "postgres"
    db_password: str = "postgres"

    # SageMaker / ML
    sagemaker_role_arn: str = ""
    sagemaker_ecr_image: str = ""
    ml_s3_bucket: str = "numeraidashboard-ml"
    ml_poller_api_key: str = ""

    # Numerai credentials (passed to SageMaker container for submission upload)
    numerai_public_id: str = ""
    numerai_secret_key: str = ""
    numerai_model_id: str = ""

    # General
    environment: str = "development"

    class Config:
        env_file = ".env"

    @property
    def database_url(self) -> str:
        return (
            f"postgresql://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )


@lru_cache
def get_settings() -> Settings:
    return Settings()
