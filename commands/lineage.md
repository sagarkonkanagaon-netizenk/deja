---
description: Show upstream and downstream lineage for a table, path or Airflow DAG
argument-hint: <table or dag:id>
---
Call the deja `lineage` tool for "$ARGUMENTS". If nothing is indexed yet, call `scan_lineage` first, then retry. Present the result as a short tree and point out anything surprising, such as a table written by more than one file.
