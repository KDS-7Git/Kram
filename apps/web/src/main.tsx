import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";
import { App } from "./App";
import { ScreenErrorBoundary } from "./components/ScreenErrorBoundary";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { networkMode: "always", staleTime: 30000, retry: 1, refetchOnWindowFocus: true },
  },
});
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <ScreenErrorBoundary><App /></ScreenErrorBoundary>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
