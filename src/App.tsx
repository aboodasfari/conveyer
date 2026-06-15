import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppTheme } from "./theme";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Settings } from "./pages/Settings";
import { TaskDetail } from "./pages/TaskDetail";
import { useScrollRestoration } from "./scrollRestoration";
import { useRunNotifications } from "./runNotifications";

function ScrollAwareLayout() {
  useScrollRestoration();
  useRunNotifications();
  return <Layout />;
}

export default function App() {
  return (
    <AppTheme>
      <BrowserRouter>
        <Routes>
          <Route element={<ScrollAwareLayout />}>
            <Route path="/" element={<Dashboard bucket="active" />} />
            <Route path="/backlog" element={<Dashboard bucket="backlog" />} />
            <Route path="/archive" element={<Dashboard bucket="archive" />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/tasks/:id" element={<TaskDetail />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </AppTheme>
  );
}
