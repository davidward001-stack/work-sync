export interface Task {
  id: string;
  created: string; // ISO 8601
  content: string;
  status: 'pending' | 'in_progress' | 'done';
  result?: string;
  completed?: string; // ISO 8601
}

export interface TaskCreateRequest {
  content: string;
}

export interface TaskUpdateRequest {
  status?: Task['status'];
  result?: string;
}
