import { useState, useEffect } from 'react';
import axios from 'axios';
import { API_URL as API } from '../config';
import { VscTerminal, VscCheck, VscClose } from 'react-icons/vsc';
import './CommandConfirmationDialog.css';

export default function CommandConfirmationDialog({ visible, commandId, command, message, tool, onApproved, onRejected, onClose }) {
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!visible) {
      setResult(null);
      setError(null);
      setExecuting(false);
    }
  }, [visible]);

  const handleApprove = async () => {
    setExecuting(true);
    setError(null);
    try {
      const response = await axios.post(`${API}/ai/command/approve`, null, {
        params: {
          command_id: commandId,
          approved: true,
        },
      });

      if (response.data.status === 'executed') {
        setResult(response.data.result);
        setExecuting(false);
        // Call onApproved callback after a short delay to show result
        setTimeout(() => {
          onApproved(response.data);
        }, 1000);
      } else if (response.data.error) {
        setError(response.data.error);
        setExecuting(false);
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to execute command');
      setExecuting(false);
    }
  };

  const handleReject = async () => {
    try {
      await axios.post(`${API}/ai/command/approve`, null, {
        params: {
          command_id: commandId,
          approved: false,
        },
      });
      onRejected();
    } catch (err) {
      console.error('Error rejecting command:', err);
      onRejected(); // Still close dialog even if API call fails
    }
  };

  if (!visible) return null;

  return (
    <div className="command-confirmation-overlay" onClick={onClose}>
      <div className="command-confirmation-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="command-confirmation-header">
          <div className="command-confirmation-icon">
            <VscTerminal size={20} />
          </div>
          <div className="command-confirmation-title">
            <h3>Command Requires Approval</h3>
            <span className="command-confirmation-tool">{tool}</span>
          </div>
        </div>

        <div className="command-confirmation-body">
          <div className="command-confirmation-message">
            {message || 'This command requires your approval before execution.'}
          </div>

          <div className="command-confirmation-command-box">
            <div className="command-confirmation-label">Command:</div>
            <code className="command-confirmation-command">{command}</code>
          </div>

          {error && (
            <div className="command-confirmation-error">
              <strong>Error:</strong> {error}
            </div>
          )}

          {result && (
            <div className="command-confirmation-result">
              <div className="command-confirmation-label">Result:</div>
              <pre className="command-confirmation-result-text">{result}</pre>
            </div>
          )}

          {executing && (
            <div className="command-confirmation-executing">
              Executing command...
            </div>
          )}
        </div>

        <div className="command-confirmation-actions">
          <button
            className="command-confirmation-btn command-confirmation-btn-reject"
            onClick={handleReject}
            disabled={executing}
          >
            <VscClose size={16} />
            Skip
          </button>
          <button
            className="command-confirmation-btn command-confirmation-btn-approve"
            onClick={handleApprove}
            disabled={executing || result}
          >
            <VscCheck size={16} />
            {executing ? 'Executing...' : result ? 'Executed' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
