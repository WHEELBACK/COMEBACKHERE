import { useState } from 'react'

interface ABIContract {
  contract: string
  version: string
  functions: string[]
}

const contracts: ABIContract[] = [
  {
    contract: 'invoice',
    version: '1.1.0',
    functions: [
      'initialize',
      'create_invoice',
      'mark_paid',
      'get_invoice',
      'get_invoice_status',
      'cancel_invoice',
      'request_refund',
      'batch_expire(offset: u32, limit: u32, returns: u32)',
      'pause',
      'unpause',
      'set_grace_window',
      'get_grace_window',
      'release_escrow',
    ],
  },
  {
    contract: 'treasury',
    version: '1.0.0',
    functions: [
      'initialize',
      'set_signer',
      'propose_settlement',
      'propose_partial_settlement',
      'approve_settlement',
      'approve_partial_settlement',
      'execute_settlement',
      'partially_execute_settlement',
      'cancel_settlement',
      'get_pending_settlements',
      'get_pending_settlements_page',
      'get_settlement',
      'update_threshold',
      'pause',
      'unpause',
      'raise_dispute',
      'resolve_dispute',
      'vote_dispute_resolution',
      'deposit',
      'withdraw',
      'add_allowed_token',
      'remove_allowed_token',
      'get_allowed_tokens',
      'propose_signer_rotation',
      'approve_signer_rotation',
      'update_merchant_payout_address',
      'get_merchant_payout_address',
      'hold_settlement',
      'release_hold',
    ],
  },
  {
    contract: 'compliance',
    version: '1.0.0',
    functions: [
      'initialize',
      'is_allowed',
      'allow_address',
      'block_address',
      'allow_address_until',
      'transfer_admin',
      'accept_admin',
      'clear_address',
      'pause',
      'unpause',
    ],
  },
]

export default function ABIExplorer() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const toggle = (contract: string) => {
    setExpanded(prev => ({ ...prev, [contract]: !prev[contract] }))
  }

  return (
    <div style={{ padding: '20px' }}>
      <h2>ABI Explorer</h2>
      <p>Deployed contract functions reference</p>
      {contracts.map(c => (
        <div key={c.contract} style={{ marginBottom: '16px', border: '1px solid #ccc', borderRadius: '4px' }}>
          <div
            onClick={() => toggle(c.contract)}
            style={{ padding: '12px', cursor: 'pointer', background: '#f9f9f9', fontWeight: 'bold' }}
          >
            {c.contract} (v{c.version}) — {c.functions.length} functions
          </div>
          {expanded[c.contract] && (
            <ul style={{ margin: 0, padding: '12px 24px' }}>
              {c.functions.map((fn, i) => (
                <li key={i} style={{ fontFamily: 'monospace', fontSize: '14px', marginBottom: '4px' }}>
                  {fn}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}
