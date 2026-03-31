#!/bin/bash
# Docker entrypoint: starts Datadog agent (if configured) then the app

if [ -n "$DD_API_KEY" ]; then
  # APM config
  export DD_APM_ENABLED=true
  export DD_APM_NON_LOCAL_TRAFFIC=false
  export DD_PROCESS_AGENT_ENABLED=false
  export DD_LOGS_ENABLED=false
  export DD_HOSTNAME=$(hostname)
  export DD_BIND_HOST=127.0.0.1

  # LLM Observability config (dd-trace sends llmobs data directly to API)
  export DD_LLMOBS_ENABLED=${DD_LLMOBS_ENABLED:-true}
  export DD_LLMOBS_ML_APP=${DD_LLMOBS_ML_APP:-formulo}
  export DD_LLMOBS_AGENTLESS_ENABLED=${DD_LLMOBS_AGENTLESS_ENABLED:-true}
  export DD_SITE=${DD_SITE:-datadoghq.eu}

  # Write agent config
  mkdir -p /etc/datadog-agent
  cat > /etc/datadog-agent/datadog.yaml << EOF
api_key: ${DD_API_KEY}
site: ${DD_SITE}
hostname: formulo-heroku
expvar_port: 5010
cmd_port: 5011
apm_config:
  enabled: true
  apm_non_local_traffic: false
process_config:
  enabled: "false"
logs_enabled: false
EOF

  echo "Starting Datadog agent..."
  /opt/datadog-agent/bin/agent/agent run &
  /opt/datadog-agent/embedded/bin/trace-agent --config /etc/datadog-agent/datadog.yaml &
  sleep 2
  echo "Datadog agent started (llmobs agentless: ${DD_LLMOBS_AGENTLESS_ENABLED})"
else
  echo "DD_API_KEY not set, skipping Datadog agent"
fi

# Execute the CMD (the app)
exec "$@"
