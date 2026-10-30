import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.mjs';
import { repo, write } from './helpers.mjs';
import { lineageFor, parseAirflow, parsePython, parseSql } from '../src/lineage.mjs';
import { recordFile, scan, trace } from '../src/graph.mjs';

const sorted = (a) => [...a].sort();

test('SQL: inserts, merges, joins and CTEs', () => {
  const r = parseSql(`
    -- daily refresh
    WITH recent AS (SELECT * FROM bronze.orders WHERE dt > current_date - 7),
         cust AS (SELECT * FROM silver.customers)
    INSERT OVERWRITE TABLE gold.daily_sales
    SELECT r.dt, sum(r.amount) FROM recent r JOIN cust c ON r.cid = c.id
    LEFT JOIN \`ref\`.\`fx_rates\` fx ON fx.ccy = r.ccy GROUP BY r.dt;
    MERGE INTO silver.customers t USING staging.customers_cdc s ON t.id = s.id
    WHEN MATCHED THEN UPDATE SET *;`);
  assert.deepEqual(sorted(r.writes), ['gold.daily_sales', 'silver.customers']);
  assert.deepEqual(sorted(r.reads), ['bronze.orders', 'ref.fx_rates', 'staging.customers_cdc']);
});

test('SQL: DDL columns are captured', () => {
  const r = parseSql(`CREATE TABLE IF NOT EXISTS silver.orders (
    order_id BIGINT NOT NULL, amount DECIMAL(12, 2), tags ARRAY<STRING>, PRIMARY KEY (order_id)
  ) USING DELTA PARTITIONED BY (dt)`);
  assert.deepEqual(r.writes, ['silver.orders']);
  assert.deepEqual(r.columns['silver.orders'], ['order_id bigint', 'amount decimal(12,2)', 'tags array<string>']);
});

test('dbt: model name is the target, ref and source are inputs', () => {
  const r = lineageFor('/x/models/marts/fct_orders.sql', `
    {{ config(materialized='incremental') }}
    select * from {{ ref('stg_orders') }} o
    join {{ source('stripe', 'payments') }} p using (order_id)
    {% if is_incremental() %} where o.updated_at > (select max(updated_at) from {{ this }}) {% endif %}`);
  assert.deepEqual(r.writes, ['fct_orders']);
  assert.deepEqual(sorted(r.reads), ['stg_orders', 'stripe.payments']);
});

test('PySpark: tables, paths and spark.sql', () => {
  const r = parsePython(`
from delta.tables import DeltaTable
orders = spark.read.table("bronze.orders")
fx = spark.read.format("parquet").load("s3://lake/raw/fx/")
spark.sql("""INSERT INTO gold.revenue SELECT * FROM silver.revenue_stage""")
(orders.join(fx, "ccy")
   .write.mode("overwrite")
   .saveAsTable("silver.orders_fx"))
orders.write.format("delta").save("abfss://lake@acct.dfs.core.windows.net/silver/orders")
DeltaTable.forName(spark, "silver.dim_customer").alias("t")
`);
  assert.deepEqual(sorted(r.writes), ['abfss://lake@acct.dfs.core.windows.net/silver/orders', 'gold.revenue', 'silver.orders_fx']);
  assert.deepEqual(sorted(r.reads), ['bronze.orders', 's3://lake/raw/fx/', 'silver.dim_customer', 'silver.revenue_stage']);
});

test('Delta Live Tables decorators', () => {
  const r = parsePython(`
import dlt
@dlt.table(comment="clean")
def orders_clean():
    return dlt.read("orders_raw").where("amount > 0")
@dlt.table(name="gold_orders")
def g():
    return dlt.read_stream("orders_clean")`);
  assert.deepEqual(sorted(r.writes), ['gold_orders', 'orders_clean']);
  assert.deepEqual(r.reads, ['orders_raw']);
});

test('Airflow: dag id, tasks and dependencies', () => {
  const dag = parseAirflow(`
with DAG("orders_daily", schedule="@daily") as dag:
    extract = BashOperator(task_id="extract", bash_command="x")
    load = SQLExecuteQueryOperator(task_id="load", sql="INSERT INTO silver.orders SELECT * FROM bronze.orders")
    notify = EmptyOperator(task_id="notify")
    extract >> load >> notify
`);
  assert.equal(dag.id, 'orders_daily');
  assert.deepEqual(dag.tasks, ['extract', 'load', 'notify']);
  assert.deepEqual(dag.deps, [['extract', 'load'], ['load', 'notify']]);
});

test('graph: multi-hop upstream and downstream across files', () => {
  const root = repo({
    'jobs/bronze_to_silver.sql': 'INSERT INTO silver.orders SELECT * FROM bronze.orders',
    'jobs/silver_to_gold.sql': 'INSERT INTO gold.revenue SELECT * FROM silver.orders JOIN silver.fx USING (ccy)',
    'jobs/report.py': 'spark.table("gold.revenue").write.saveAsTable("bi.revenue_dashboard")',
    'dags/orders.py': `with DAG(dag_id="orders") as dag:\n    a = SQLExecuteQueryOperator(task_id="a", sql="INSERT INTO silver.orders SELECT * FROM bronze.orders")\n`,
  });
  const r = scan(root);
  assert.equal(r.withLineage, 4);
  const t = trace(root, 'gold.revenue');
  assert.deepEqual(sorted(t.upstream.map((e) => e.to)), ['bronze.orders', 'silver.fx', 'silver.orders']);
  assert.deepEqual(t.downstream.map((e) => e.to), ['bi.revenue_dashboard']);
  assert.ok(trace(root, 'dag:orders').downstream.some((e) => e.to === 'silver.orders'));

  // Editing a file replaces what it said before.
  recordFile(root, write(root, 'jobs/report.py', 'spark.table("gold.revenue").write.saveAsTable("bi.revenue_v2")'));
  assert.deepEqual(trace(root, 'gold.revenue').downstream.map((e) => e.to), ['bi.revenue_v2']);
});
