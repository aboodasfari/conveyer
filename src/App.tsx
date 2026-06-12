import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppTheme } from "./theme";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Settings } from "./pages/Settings";
import { TaskDetail } from "./pages/TaskDetail";

export default function App() {
  return (
    <AppTheme>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/tasks/:id" element={<TaskDetail />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppTheme>
  );
}
