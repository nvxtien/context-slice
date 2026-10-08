export class WorkflowError extends Error {
    code;
    remediation;
    constructor(code, message, remediation) {
        super(message);
        this.code = code;
        this.remediation = remediation;
        this.name = "WorkflowError";
    }
}
