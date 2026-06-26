import React, { Component, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Error caught by boundary:", error, errorInfo);
  }

  resetError = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            backgroundColor: "var(--bg-color, #f5f5f5)",
            color: "var(--text-color, #333)",
            padding: "2rem",
            textAlign: "center",
          }}
        >
          <div
            style={{
              backgroundColor: "var(--error-bg, #fee)",
              border: "1px solid var(--error-border, #fcc)",
              borderRadius: "0.5rem",
              padding: "2rem",
              maxWidth: "500px",
            }}
          >
            <h1 style={{ marginTop: 0, color: "var(--error-text, #c33)" }}>
              Oops! Something went wrong
            </h1>
            <p style={{ marginBottom: "1rem", fontSize: "0.95rem" }}>
              {this.state.error?.message || "An unexpected error occurred"}
            </p>
            <button
              onClick={this.resetError}
              style={{
                padding: "0.6rem 1.2rem",
                backgroundColor: "var(--primary-color, #007bff)",
                color: "white",
                border: "none",
                borderRadius: "0.3rem",
                cursor: "pointer",
                fontSize: "1rem",
              }}
            >
              Retry
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
