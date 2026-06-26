use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvoiceStatus {
    Pending,
    Paid,
    Expired,
    Cancelled,
    RefundRequested,
    Released,
}

impl InvoiceStatus {
    /// Map from Soroban contract u32 discriminant to InvoiceStatus.
    pub fn from_u32(v: u32) -> Option<Self> {
        match v {
            0 => Some(Self::Pending),
            1 => Some(Self::Paid),
            2 => Some(Self::Expired),
            3 => Some(Self::Cancelled),
            4 => Some(Self::RefundRequested),
            5 => Some(Self::Released),
            _ => None,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
pub struct InvoiceResponse {
    pub id: u64,
    pub merchant: String,
    pub payer: Option<String>,
    pub token: Option<String>,
    pub amount_usdc: u64,
    pub gross_usdc: u64,
    pub status: InvoiceStatus,
    pub due_date: u64,
    pub paid_at: Option<u64>,
    pub created_at: Option<u64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub error: String,
    pub code: Option<u32>,
}

/// Soroban RPC request shape (minimal).
#[derive(Debug, Serialize)]
pub struct RpcRequest {
    pub jsonrpc: &'static str,
    pub id: u32,
    pub method: &'static str,
    pub params: serde_json::Value,
}

/// Soroban RPC response shape (minimal).
#[derive(Debug, Deserialize)]
pub struct RpcResponse {
    pub result: Option<serde_json::Value>,
    pub error: Option<serde_json::Value>,
}
