"""Remove cookie storage for the retired crawler source.

Revision ID: 0009_remove_retired_source_cookies
Revises: 0008_add_readnovelmtl_cookies
"""

import sqlalchemy as sa
from alembic import op

revision = "0009_remove_retired_source_cookies"
down_revision = "0008_add_readnovelmtl_cookies"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if "readnovelmtl_cookies" in sa.inspect(bind).get_table_names():
        op.drop_table("readnovelmtl_cookies")


def downgrade() -> None:
    pass
