use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use std::{
    fs::OpenOptions,
    io::{self, IsTerminal, Write},
    os::unix::fs::OpenOptionsExt,
    path::PathBuf,
    process,
};

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------

#[derive(Debug, Parser)]
#[command(
    name = "cbh",
    version,
    about = "COMEBACKHERE protocol CLI – pre-flight checks and config scaffolding"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    /// Run pre-flight connectivity checks against webhook and Horizon endpoints.
    ///
    /// Issue #226: --format json is now compatible with --check-webhooks and
    /// --check-horizon.  The conflict has been removed and both check arrays are
    /// included in the JSON output.
    Check {
        /// Webhook URL to probe (may be repeated).
        #[arg(long = "check-webhooks", value_name = "URL")]
        check_webhooks: Vec<String>,

        /// Horizon base URL to probe (may be repeated).
        #[arg(long = "check-horizon", value_name = "URL")]
        check_horizon: Vec<String>,

        /// Output format.  `json` is compatible with all check flags.
        /// (Issue #226: conflicts_with_all removed.)
        #[arg(long, value_enum, default_value_t = OutputFormat::Text)]
        format: OutputFormat,
    },

    /// Scaffold a new comebackhere.toml config file.
    ///
    /// Issue #227: Uses create_new to avoid check-then-write race; writes 0600.
    /// Issue #228: Detects non-TTY stdin and fails fast with the list of
    ///             missing flags instead of blocking.
    /// Issue #229: Accepts --label, repeatable --rule, --horizon-url; validates
    ///             --network before any interactive prompt.
    Init {
        /// Output path for the generated config file.
        #[arg(long, default_value = "comebackhere.toml")]
        output: PathBuf,

        /// Overwrite the file if it already exists.
        /// Without this flag the command will fail atomically if the file exists.
        #[arg(long)]
        force: bool,

        /// Skip all interactive prompts; every required value must be supplied
        /// via flags.  Also activated automatically when stdin is not a TTY.
        #[arg(long)]
        non_interactive: bool,

        // ---- Issue #229: new flags ----------------------------------------

        /// Human-readable label for this config (e.g. "My Contract").
        #[arg(long)]
        label: Option<String>,

        /// Network to target.  Must be one of: mainnet, testnet, futurenet, or
        /// "custom" (requires --horizon-url).
        /// Validated before any interactive prompt (Issue #229).
        #[arg(long)]
        network: Option<String>,

        /// Custom Horizon base URL (required when --network custom).
        #[arg(long)]
        horizon_url: Option<String>,

        /// Webhook endpoint to call on matching events (may be repeated).
        #[arg(long)]
        webhook_url: Vec<String>,

        /// Rule preset to enable.  May be repeated.
        /// Supported values: failed, admin, large-transfer=<threshold_stroops>.
        /// Example: --rule failed --rule large-transfer=10000
        #[arg(long = "rule")]
        rules: Vec<String>,
    },
}

#[derive(Debug, Clone, ValueEnum)]
enum OutputFormat {
    Text,
    Json,
}

// ---------------------------------------------------------------------------
// Check-result types (Issue #226)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct CheckResult {
    url: String,
    ok: bool,
    status: Option<u16>,
    error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct CheckOutput {
    webhook_checks: Vec<CheckResult>,
    horizon_checks: Vec<CheckResult>,
    /// true only when every individual check passed
    success: bool,
}

// ---------------------------------------------------------------------------
// Config types (Issues #227 / #228 / #229)
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Network {
    Mainnet,
    Testnet,
    Futurenet,
    Custom,
}

impl Network {
    fn default_horizon_url(&self) -> Option<&'static str> {
        match self {
            Network::Mainnet => Some("https://horizon.stellar.org"),
            Network::Testnet => Some("https://horizon-testnet.stellar.org"),
            Network::Futurenet => Some("https://horizon-futurenet.stellar.org"),
            Network::Custom => None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct RuleConfig {
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    threshold_stroops: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct Config {
    label: String,
    network: String,
    horizon_url: String,
    webhook_urls: Vec<String>,
    rules: Vec<RuleConfig>,
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

fn main() {
    if let Err(err) = run() {
        eprintln!("error: {err:#}");
        process::exit(1);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();

    match cli.command {
        Commands::Check {
            check_webhooks,
            check_horizon,
            format,
        } => cmd_check(check_webhooks, check_horizon, format),

        Commands::Init {
            output,
            force,
            non_interactive,
            label,
            network,
            horizon_url,
            webhook_url,
            rules,
        } => cmd_init(
            output,
            force,
            non_interactive,
            label,
            network,
            horizon_url,
            webhook_url,
            rules,
        ),
    }
}

// ---------------------------------------------------------------------------
// `cbh check` – Issue #226
// ---------------------------------------------------------------------------

fn cmd_check(
    webhook_urls: Vec<String>,
    horizon_urls: Vec<String>,
    format: OutputFormat,
) -> Result<()> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .context("failed to build HTTP client")?;

    let webhook_checks: Vec<CheckResult> = webhook_urls
        .iter()
        .map(|url| probe(&client, url, "webhook"))
        .collect();

    let horizon_checks: Vec<CheckResult> = horizon_urls
        .iter()
        .map(|url| {
            let health = format!("{}/health", url.trim_end_matches('/'));
            probe(&client, &health, "horizon")
        })
        .collect();

    let success = webhook_checks.iter().all(|c| c.ok)
        && horizon_checks.iter().all(|c| c.ok);

    match format {
        OutputFormat::Json => {
            // Issue #226: webhook_checks and horizon_checks are always included
            // in the JSON output regardless of which flags were supplied.
            let out = CheckOutput {
                webhook_checks,
                horizon_checks,
                success,
            };
            println!("{}", serde_json::to_string_pretty(&out)?);
        }
        OutputFormat::Text => {
            print_text_checks("Webhook", &webhook_checks);
            print_text_checks("Horizon", &horizon_checks);
            if success {
                println!("\nAll checks passed.");
            } else {
                eprintln!("\nOne or more checks failed.");
            }
        }
    }

    if !success {
        // Issue #226: keep exit code 1 when any check fails
        process::exit(1);
    }

    Ok(())
}

fn probe(client: &reqwest::blocking::Client, url: &str, _kind: &str) -> CheckResult {
    match client.get(url).send() {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let ok = resp.status().is_success();
            CheckResult {
                url: url.to_string(),
                ok,
                status: Some(status),
                error: if ok {
                    None
                } else {
                    Some(format!("HTTP {status}"))
                },
            }
        }
        Err(err) => CheckResult {
            url: url.to_string(),
            ok: false,
            status: None,
            error: Some(err.to_string()),
        },
    }
}

fn print_text_checks(label: &str, results: &[CheckResult]) {
    if results.is_empty() {
        return;
    }
    println!("{} checks:", label);
    for r in results {
        if r.ok {
            println!("  ✓  {}", r.url);
        } else {
            println!(
                "  ✗  {}  – {}",
                r.url,
                r.error.as_deref().unwrap_or("failed")
            );
        }
    }
}

// ---------------------------------------------------------------------------
// `cbh init` – Issues #227, #228, #229
// ---------------------------------------------------------------------------

#[allow(clippy::too_many_arguments)]
fn cmd_init(
    output: PathBuf,
    force: bool,
    non_interactive: bool,
    label: Option<String>,
    network: Option<String>,
    horizon_url: Option<String>,
    webhook_urls: Vec<String>,
    rule_strs: Vec<String>,
) -> Result<()> {
    // Issue #228: detect non-TTY stdin automatically, or honour the flag.
    let is_tty = io::stdin().is_terminal();
    let non_interactive = non_interactive || !is_tty;

    // Issue #229: validate --network *before* any interactive prompts.
    let network_parsed = if let Some(ref n) = network {
        Some(parse_network(n)?)
    } else {
        None
    };

    // If --network custom, --horizon-url is required.
    if let Some(Network::Custom) = &network_parsed {
        if horizon_url.is_none() {
            bail!("--horizon-url is required when --network custom is used");
        }
    }

    // Gather required values, prompting interactively only when allowed.
    let label = resolve_required(
        label,
        "label",
        "Enter a label for this config [My Contract]: ",
        Some("My Contract".to_string()),
        non_interactive,
    )?;

    let network_str = resolve_required(
        network,
        "network",
        "Enter network (mainnet/testnet/futurenet/custom) [testnet]: ",
        Some("testnet".to_string()),
        non_interactive,
    )?;

    // Re-parse after interactive fallback.
    let network_parsed = parse_network(&network_str)?;

    let horizon_url = resolve_required(
        horizon_url.or_else(|| {
            network_parsed
                .default_horizon_url()
                .map(str::to_owned)
        }),
        "horizon-url",
        "Enter Horizon base URL: ",
        None,
        non_interactive,
    )?;

    // Issue #229: parse --rule presets.
    let rules = parse_rules(&rule_strs)?;

    let config = Config {
        label,
        network: network_str,
        horizon_url,
        webhook_urls,
        rules,
    };

    write_config(&output, &config, force)?;

    eprintln!("Config written to {}", output.display());
    Ok(())
}

/// Validate the network string.
fn parse_network(s: &str) -> Result<Network> {
    match s.to_lowercase().as_str() {
        "mainnet" => Ok(Network::Mainnet),
        "testnet" => Ok(Network::Testnet),
        "futurenet" => Ok(Network::Futurenet),
        "custom" => Ok(Network::Custom),
        other => bail!(
            "unknown network {:?}; expected mainnet, testnet, futurenet, or custom",
            other
        ),
    }
}

/// Issue #229: parse rule preset strings like "failed", "admin",
/// "large-transfer=10000".
fn parse_rules(strs: &[String]) -> Result<Vec<RuleConfig>> {
    let mut rules = Vec::new();
    for s in strs {
        if let Some(threshold) = s.strip_prefix("large-transfer=") {
            let threshold_stroops: u64 = threshold
                .parse()
                .with_context(|| format!("invalid threshold in rule {:?}", s))?;
            rules.push(RuleConfig {
                kind: "large_transfer".to_string(),
                threshold_stroops: Some(threshold_stroops),
            });
        } else {
            match s.as_str() {
                "failed" => rules.push(RuleConfig {
                    kind: "failed_transaction".to_string(),
                    threshold_stroops: None,
                }),
                "admin" => rules.push(RuleConfig {
                    kind: "admin_operation".to_string(),
                    threshold_stroops: None,
                }),
                other => bail!(
                    "unknown rule preset {:?}; supported: failed, admin, large-transfer=<n>",
                    other
                ),
            }
        }
    }

    // Default to AnyTransaction when no rules were specified, preserving
    // backward-compatible behaviour.
    if rules.is_empty() {
        rules.push(RuleConfig {
            kind: "any_transaction".to_string(),
            threshold_stroops: None,
        });
    }

    Ok(rules)
}

/// Resolve a value: use the supplied one if present, otherwise prompt the user
/// (unless non_interactive is true, in which case fail fast).
///
/// Issue #228: when non_interactive is true and no value is available the
/// function returns an error listing the missing flag.
fn resolve_required(
    value: Option<String>,
    flag_name: &str,
    prompt: &str,
    default: Option<String>,
    non_interactive: bool,
) -> Result<String> {
    if let Some(v) = value {
        return Ok(v);
    }
    if non_interactive {
        if let Some(d) = default {
            return Ok(d);
        }
        bail!(
            "missing required flag --{flag_name} (stdin is not a TTY or --non-interactive was set)"
        );
    }
    // Interactive path: print prompt to stderr so it doesn't pollute stdout.
    eprint!("{prompt}");
    io::stderr().flush().ok();

    let mut buf = String::new();
    io::stdin().read_line(&mut buf)?;
    let trimmed = buf.trim().to_string();
    if trimmed.is_empty() {
        if let Some(d) = default {
            return Ok(d);
        }
        bail!("--{flag_name} is required");
    }
    Ok(trimmed)
}

/// Write the config to disk.
///
/// Issue #227: uses create_new(true) to fail atomically if the file already
/// exists (rather than the previous check-then-write race).  Permissions are
/// set to 0600 because the file may hold a webhook secret token.
/// --force reopens with truncate instead.
fn write_config(path: &PathBuf, config: &Config, force: bool) -> Result<()> {
    let toml_str = toml::to_string_pretty(config).context("failed to serialise config")?;

    if force {
        // Overwrite unconditionally; still apply 0600.
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("failed to open {:?} for writing", path))?;
        file.write_all(toml_str.as_bytes())?;
    } else {
        // Issue #227: create_new guarantees atomicity – no race between
        // the existence check and the actual write.
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)   // fails with AlreadyExists if the file exists
            .mode(0o600)        // Issue #227: 0600 because file may hold secrets
            .open(path)
            .with_context(|| {
                format!(
                    "{} already exists; use --force to overwrite",
                    path.display()
                )
            })?;
        file.write_all(toml_str.as_bytes())?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // ---- Issue #226 --------------------------------------------------------

    #[test]
    fn check_output_serialises_both_arrays() {
        let out = CheckOutput {
            webhook_checks: vec![CheckResult {
                url: "https://example.com/hook".into(),
                ok: true,
                status: Some(200),
                error: None,
            }],
            horizon_checks: vec![CheckResult {
                url: "https://horizon.stellar.org/health".into(),
                ok: false,
                status: Some(503),
                error: Some("HTTP 503".into()),
            }],
            success: false,
        };
        let json = serde_json::to_string(&out).unwrap();
        assert!(json.contains("\"webhook_checks\""));
        assert!(json.contains("\"horizon_checks\""));
        assert!(json.contains("\"success\":false"));
    }

    // ---- Issue #227 --------------------------------------------------------

    #[test]
    fn write_config_fails_when_file_exists_without_force() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("comebackhere.toml");

        let cfg = default_test_config();
        write_config(&path, &cfg, false).expect("first write should succeed");

        let err = write_config(&path, &cfg, false).unwrap_err();
        assert!(
            err.to_string().contains("already exists"),
            "expected 'already exists' error, got: {err}"
        );
    }

    #[test]
    fn write_config_force_overwrites_existing_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("comebackhere.toml");

        let cfg = default_test_config();
        write_config(&path, &cfg, false).unwrap();
        // Second write with force should succeed.
        write_config(&path, &cfg, true).expect("force write should succeed");
    }

    #[test]
    fn written_file_has_restricted_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().unwrap();
        let path = dir.path().join("comebackhere.toml");

        let cfg = default_test_config();
        write_config(&path, &cfg, false).unwrap();

        let meta = std::fs::metadata(&path).unwrap();
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "expected 0600 permissions, got {:o}", mode);
    }

    // ---- Issue #228 --------------------------------------------------------

    #[test]
    fn resolve_required_returns_value_when_provided() {
        let result = resolve_required(
            Some("my-value".into()),
            "label",
            "ignored",
            None,
            true, // non_interactive
        );
        assert_eq!(result.unwrap(), "my-value");
    }

    #[test]
    fn resolve_required_uses_default_in_non_interactive_mode() {
        let result = resolve_required(
            None,
            "label",
            "ignored",
            Some("Default Label".into()),
            true,
        );
        assert_eq!(result.unwrap(), "Default Label");
    }

    #[test]
    fn resolve_required_fails_fast_when_no_value_and_no_default_non_interactive() {
        let err = resolve_required(None, "horizon-url", "ignored", None, true).unwrap_err();
        assert!(
            err.to_string().contains("missing required flag --horizon-url"),
            "unexpected error: {err}"
        );
    }

    // ---- Issue #229 --------------------------------------------------------

    #[test]
    fn parse_network_rejects_unknown_values() {
        let err = parse_network("oops").unwrap_err();
        assert!(err.to_string().contains("unknown network"));
    }

    #[test]
    fn parse_network_accepts_all_known_values() {
        assert_eq!(parse_network("mainnet").unwrap(), Network::Mainnet);
        assert_eq!(parse_network("testnet").unwrap(), Network::Testnet);
        assert_eq!(parse_network("futurenet").unwrap(), Network::Futurenet);
        assert_eq!(parse_network("custom").unwrap(), Network::Custom);
    }

    #[test]
    fn parse_rules_defaults_to_any_transaction() {
        let rules = parse_rules(&[]).unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].kind, "any_transaction");
    }

    #[test]
    fn parse_rules_handles_presets() {
        let input: Vec<String> = vec![
            "failed".into(),
            "admin".into(),
            "large-transfer=10000".into(),
        ];
        let rules = parse_rules(&input).unwrap();
        assert_eq!(rules.len(), 3);
        assert_eq!(rules[0].kind, "failed_transaction");
        assert_eq!(rules[1].kind, "admin_operation");
        assert_eq!(rules[2].kind, "large_transfer");
        assert_eq!(rules[2].threshold_stroops, Some(10000));
    }

    #[test]
    fn parse_rules_rejects_unknown_preset() {
        let input = vec!["banana".to_string()];
        let err = parse_rules(&input).unwrap_err();
        assert!(err.to_string().contains("unknown rule preset"));
    }

    #[test]
    fn parse_rules_rejects_bad_threshold() {
        let input = vec!["large-transfer=abc".to_string()];
        let err = parse_rules(&input).unwrap_err();
        assert!(err.to_string().contains("invalid threshold"));
    }

    #[test]
    fn mainnet_horizon_url_is_correct() {
        assert_eq!(
            Network::Mainnet.default_horizon_url(),
            Some("https://horizon.stellar.org")
        );
    }

    #[test]
    fn custom_network_has_no_default_horizon_url() {
        assert!(Network::Custom.default_horizon_url().is_none());
    }

    #[test]
    fn config_roundtrips_through_toml() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("comebackhere.toml");

        let cfg = Config {
            label: "Test Config".into(),
            network: "testnet".into(),
            horizon_url: "https://horizon-testnet.stellar.org".into(),
            webhook_urls: vec!["https://example.com/hook".into()],
            rules: vec![RuleConfig {
                kind: "failed_transaction".into(),
                threshold_stroops: None,
            }],
        };

        write_config(&path, &cfg, false).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        let parsed: Config = toml::from_str(&raw).unwrap();

        assert_eq!(parsed.label, cfg.label);
        assert_eq!(parsed.network, cfg.network);
        assert_eq!(parsed.horizon_url, cfg.horizon_url);
        assert_eq!(parsed.rules[0].kind, cfg.rules[0].kind);
    }

    // ---- helpers -----------------------------------------------------------

    fn default_test_config() -> Config {
        Config {
            label: "My Contract".into(),
            network: "testnet".into(),
            horizon_url: "https://horizon-testnet.stellar.org".into(),
            webhook_urls: vec![],
            rules: vec![RuleConfig {
                kind: "any_transaction".into(),
                threshold_stroops: None,
            }],
        }
    }
}
