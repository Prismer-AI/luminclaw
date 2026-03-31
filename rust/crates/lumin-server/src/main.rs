//! Lumin Gateway Server — HTTP + WebSocket (Rust implementation).
//!
//! Same endpoint contract as the TypeScript version:
//! - GET  /health      — health check
//! - GET  /v1/tools    — list available tools
//! - POST /v1/chat     — send message, get JSON response
//! - POST /v1/artifacts — upload artifact
//! - WS   /v1/stream   — real-time WebSocket streaming

use axum::{
    Router,
    routing::{get, post},
    extract::State,
    response::Json,
};
use clap::Parser;
use lumin_core::{LuminConfig, create_agent_loop, resolve_loop_mode, LoopMode};
use std::sync::Arc;
use tracing::info;

mod http;
mod ws;

#[derive(Parser)]
#[command(name = "lumin-server", about = "Lumin Agent Gateway (Rust)")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(clap::Subcommand)]
enum Commands {
    /// Start the HTTP + WebSocket server
    Serve {
        #[arg(long, default_value = "3001")]
        port: u16,
    },
    /// Send a single message and print the response (CLI mode)
    Agent {
        #[arg(long)]
        message: String,
    },
}

pub(crate) struct AppState {
    pub config: LuminConfig,
    pub loop_mode: LoopMode,
    pub start_time: std::time::Instant,
    pub sessions: lumin_core::SessionStore,
    pub tasks: lumin_core::task::InMemoryTaskStore,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .json()
        .init();

    let cli = Cli::parse();

    match cli.command {
        Commands::Agent { message } => {
            let config = LuminConfig::from_env();
            let provider = lumin_core::OpenAIProvider::new(
                &config.llm.base_url, &config.llm.api_key, &config.llm.model,
            );
            let mut tools = lumin_core::ToolRegistry::new();
            tools.register(lumin_core::tools::create_bash_tool(config.workspace.dir.clone()));
            let bus = lumin_core::sse::EventBus::default();
            let mut session = lumin_core::Session::new("cli-session");

            // Build prompt
            let mut pb = lumin_core::PromptBuilder::new(&config.workspace.dir);
            pb.load_identity();
            pb.load_tools_ref();
            pb.load_user_profile();
            pb.add_runtime_info(Some("researcher"), Some(&config.llm.model), Some(tools.size()));
            let system_prompt = pb.build();

            let agent = lumin_core::PrismerAgent::new(
                Arc::new(provider), Arc::new(tools), Arc::new(bus),
                system_prompt, config.llm.model.clone(),
                "researcher".into(), config.workspace.dir.clone(),
            );

            match agent.process_message(&message, &mut session, None).await {
                Ok(result) => {
                    lumin_core::ipc::write_output(&lumin_core::ipc::OutputMessage {
                        status: "success".into(),
                        response: Some(result.text),
                        thinking: result.thinking,
                        error: None,
                        session_id: Some(session.id.clone()),
                        iterations: Some(result.iterations),
                        tools_used: Some(result.tools_used),
                    });
                }
                Err(e) => {
                    lumin_core::ipc::write_output(&lumin_core::ipc::OutputMessage {
                        status: "error".into(),
                        response: None, thinking: None,
                        error: Some(e),
                        session_id: Some(session.id.clone()),
                        iterations: None, tools_used: None,
                    });
                }
            }
        }
        Commands::Serve { port } => {
            let config = LuminConfig::from_env();
            let loop_mode = resolve_loop_mode(None);

            info!(mode = %loop_mode, port, "starting lumin gateway (rust)");

            let state = Arc::new(AppState {
                config: config.clone(), loop_mode,
                start_time: std::time::Instant::now(),
                sessions: lumin_core::SessionStore::new(),
                tasks: lumin_core::task::InMemoryTaskStore::new(),
            });

            let app = Router::new()
                .route("/health", get(http::health))
                .route("/", get(http::health))
                .route("/v1/tools", get(http::list_tools))
                .route("/v1/chat", post(http::chat))
                .route("/v1/artifacts", post(http::artifacts))
                .route("/v1/tasks", get(http::list_tasks))
                .route("/v1/tasks/{id}", get(http::get_task))
                .route("/v1/stream", get(ws::ws_handler))
                .with_state(state);

            let addr = format!("0.0.0.0:{port}");
            let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");

            info!(addr = %addr, "gateway started");
            eprintln!("\n╔═══════════════════════════════════════════════╗");
            eprintln!("║  Lumin v0.1.0-rust — Agent Gateway             ║");
            eprintln!("╠═══════════════════════════════════════════════╣");
            eprintln!("║  HTTP:  http://0.0.0.0:{port}/health");
            eprintln!("║  Chat:  POST http://0.0.0.0:{port}/v1/chat");
            eprintln!("║  WS:    ws://0.0.0.0:{port}/v1/stream");
            eprintln!("╚═══════════════════════════════════════════════╝\n");

            axum::serve(listener, app)
                .with_graceful_shutdown(shutdown_signal())
                .await
                .expect("server");
        }
    }
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c().await.ok();
    info!("shutting down");
}
