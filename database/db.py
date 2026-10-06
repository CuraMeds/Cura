import os
import uuid
from contextlib import contextmanager
import psycopg2
from psycopg2 import pool
from dotenv import load_dotenv

load_dotenv()  # Load environment variables from .env file

DATABASE_URL = os.getenv('DATABASE_URL')

_pool = None

def init_pool(minconn=1, maxconn=5):
    global _pool
    if _pool is None:
        if not DATABASE_URL:
            raise RuntimeError('DATABASE_URL not set')
        _pool = psycopg2.pool.SimpleConnectionPool(minconn, maxconn, dsn=DATABASE_URL)
    return _pool

@contextmanager
def get_conn():
    global _pool
    if _pool is None:
        init_pool()
    conn = _pool.getconn()
    try:
        yield conn
    finally:
        _pool.putconn(conn)

@contextmanager
def transaction():
    with get_conn() as conn:
        try:
            cur = conn.cursor()
            yield cur
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()

def gen_uuid():
    return str(uuid.uuid4())
