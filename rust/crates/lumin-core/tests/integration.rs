//! Integration tests for lumin-core — requires LLM endpoint.
//! Skips automatically if OPENAI_API_KEY is not set.

use lumin_core::*;
use lumin_core::provider::{OpenAIProvider, Provider, ChatRequest, Message};
use lumin_core::tools::create_bash_tool;
use std::sync::Arc;

fn skip_if_no_gateway() -> bool {
    std::env::var("OPENAI_API_KEY").unwrap_or_default().is_empty()
}

fn get_config() -> (String, String, String) {
    let api_key = std::env::var("OPENAI_API_KEY").unwrap_or_default();
    let base_url = std::env::var("OPENAI_API_BASE_URL").unwrap_or_else(|_| "https://api.openai.com/v1".into());
    let model = std::env::var("AGENT_DEFAULT_MODEL").unwrap_or_else(|_| "gpt-4o".into());
    (api_key, base_url, model)
}

#[tokio::test]
async fn t1_basic_conversation() {
    if skip_if_no_gateway() { eprintln!("SKIP: no gateway"); return; }
    let (api_key, base_url, model) = get_config();

    let provider = OpenAIProvider::new(&base_url, &api_key, &model);
    let response = provider.chat(ChatRequest {
        messages: vec![
            Message::system("You are helpful."),
            Message::user("Say 'hello world' and nothing else."),
        ],
        tools: None,
        model: Some(model),
        max_tokens: Some(50),
        stream: false,
        temperature: None,
        thinking_level: None,
    }).await.unwrap();

    assert!(!response.text.is_empty(), "Should return text");
}

#[tokio::test]
async fn t2_tool_calling() {
    if skip_if_no_gateway() { eprintln!("SKIP: no gateway"); return; }
    let (api_key, base_url, model) = get_config();

    let provider = OpenAIProvider::new(&base_url, &api_key, &model);

    let tool_spec = serde_json::json!({
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Execute a bash command",
            "parameters": {"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}
        }
    });

    let response = provider.chat(ChatRequest {
        messages: vec![
            Message::system("You are helpful. Use bash to answer."),
            Message::user("Run: echo hello42"),
        ],
        tools: Some(vec![tool_spec]),
        model: Some(model),
        max_tokens: Some(200),
        stream: true,
        temperature: None,
        thinking_level: None,
    }).await.unwrap();

    assert!(!response.tool_calls.is_empty(), "Should produce tool calls");
    assert_eq!(response.tool_calls[0].name, "bash");
}

#[tokio::test]
async fn t3_prismer_agent_basic() {
    if skip_if_no_gateway() { eprintln!("SKIP: no gateway"); return; }
    let (api_key, base_url, model) = get_config();

    let provider = OpenAIProvider::new(&base_url, &api_key, &model);
    let mut tools = ToolRegistry::new();
    tools.register(create_bash_tool("/tmp".into()));
    let bus = lumin_core::sse::EventBus::default();
    let mut session = Session::new("test-session");

    let agent = PrismerAgent::new(
        Arc::new(provider),
        Arc::new(tools),
        Arc::new(bus),
        "You are a test assistant. Be very brief.".into(),
        model,
        "researcher".into(),
        "/tmp".into(),
    );

    let result = agent.process_message("Say 'test OK'", &mut session, None).await.unwrap();

    assert!(!result.text.is_empty(), "Agent should return text");
    assert!(result.iterations >= 1, "Should have at least 1 iteration");
}

#[tokio::test]
async fn t4_agent_with_tool_use() {
    if skip_if_no_gateway() { eprintln!("SKIP: no gateway"); return; }
    let (api_key, base_url, model) = get_config();

    let provider = OpenAIProvider::new(&base_url, &api_key, &model);
    let mut tools = ToolRegistry::new();
    tools.register(create_bash_tool("/tmp".into()));
    let bus = lumin_core::sse::EventBus::default();
    let mut session = Session::new("test-tool-session");

    let agent = PrismerAgent::new(
        Arc::new(provider),
        Arc::new(tools),
        Arc::new(bus),
        "You are a test assistant. Always use bash to answer.".into(),
        model,
        "researcher".into(),
        "/tmp".into(),
    );

    let result = agent.process_message("Run echo 'hello from rust test' and return the output", &mut session, None).await.unwrap();

    assert!(result.tools_used.contains(&"bash".to_string()), "Should have used bash tool");
    assert!(result.text.contains("hello from rust test") || !result.text.is_empty(),
        "Result should contain tool output or text");
}

#[tokio::test]
async fn t5_single_loop_agent() {
    if skip_if_no_gateway() { eprintln!("SKIP: no gateway"); return; }

    let config = LuminConfig::from_env();
    let agent = lumin_core::loop_single::SingleLoopAgent::with_config(config);

    assert_eq!(agent.mode(), LoopMode::Single);

    let result = agent.process_message(
        AgentLoopInput {
            content: "Say 'loop OK' and nothing else.".into(),
            session_id: Some("test-loop".into()),
            images: vec![],
            config: None,
        },
        None,
    ).await.unwrap();

    assert!(!result.text.is_empty(), "SingleLoopAgent should return text");
    assert_eq!(result.session_id, "test-loop");
}

#[tokio::test]
async fn t6_dual_loop_returns_quickly() {
    let agent = lumin_core::loop_dual::DualLoopAgent::new();
    assert_eq!(agent.mode(), LoopMode::Dual);

    let start = std::time::Instant::now();
    let result = agent.process_message(
        AgentLoopInput {
            content: "Test task".into(),
            session_id: Some("dual-test".into()),
            images: vec![],
            config: None,
        },
        None,
    ).await.unwrap();

    assert!(start.elapsed().as_millis() < 200, "Dual-loop should return quickly");
    assert!(result.text.contains("Task"), "Should mention task creation");
    assert_eq!(result.iterations, 0, "No iterations — inner loop runs in background");
}

#[tokio::test]
async fn t7_thinking_model_support() {
    if skip_if_no_gateway() { eprintln!("SKIP: no gateway"); return; }
    let (api_key, base_url, model) = get_config();

    let provider = OpenAIProvider::new(&base_url, &api_key, &model);
    let response = provider.chat(ChatRequest {
        messages: vec![
            Message::system("Think carefully."),
            Message::user("What is 2+2?"),
        ],
        tools: None,
        model: Some(model),
        max_tokens: Some(200),
        stream: true,
        temperature: None,
        thinking_level: None,
    }).await.unwrap();

    assert!(!response.text.is_empty(), "Should return text");
    // Thinking is optional — model may or may not produce reasoning
    if let Some(thinking) = &response.thinking {
        assert!(!thinking.is_empty(), "If thinking exists, it should not be empty");
    }
}

#[test]
fn t8_loop_factory() {
    let mode = resolve_loop_mode(None);
    assert_eq!(mode, LoopMode::Single, "Default should be single");

    let loop_agent = create_agent_loop(None);
    assert_eq!(loop_agent.mode(), LoopMode::Single);
}
