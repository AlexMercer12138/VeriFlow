module child (
    input  logic clk,
    input  logic enable,
    output logic done
);
endmodule

module top (
    input  logic clk,
    output logic done
);
    logic next_data;

    child u_child (
        .clk(clk),
        .enable(1'b1),
        .done(done)
    );

    always_comb begin
        next_data = 1'b0;
    end
endmodule

module edge_top (
    input  logic source,
    inout  wire  shared,
    output logic constant_out,
    output logic expression_out
);
    logic unused_done;

    child u_fanout (
        .clk(source),
        .enable(),
        .done(unused_done)
    );
    child u_raw (
        .clk(source),
        .enable(source & shared),
        .done()
    );

    assign constant_out = 1'b0;
    assign expression_out = source & shared;
endmodule
